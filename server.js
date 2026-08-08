const express = require("express");
const { chromium } = require("playwright");
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const app = express();
const path = require("path");

app.use(express.static(path.join(__dirname, "public")));

const PORT = 3000;

let page;
let controls = {};

// the initial /playlist batch, kept so /playlist-more can pick up where
// it left off without re-scraping it - relevant now that /playlist
// pre-positions the scrollbar past this batch before responding
let lastPlaylistInitialTracks = [];

const FOLDER_ICON = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23888" d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';

async function waitForStableCount(locator, { checks = 3, interval = 400, timeout = 8000 } = {}) {

    const start = Date.now();
    let lastCount = -1;
    let stableChecks = 0;

    while (Date.now() - start < timeout) {

        const count = await locator.count();

        if (count === lastCount) {
            stableChecks++;
            if (stableChecks >= checks) return count;
        } else {
            stableChecks = 0;
            lastCount = count;
        }

        await new Promise(r => setTimeout(r, interval));
    }

    return lastCount;
}

async function clickDiscographyChip(chipLabel) {

    return await page.evaluate((label) => {

        const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];

        const discoShelf = shelves.find(s =>
            s.querySelector('[data-testid="rich-title-row-shelf-header"]')?.innerText.startsWith('Discographie')
        );

        if (!discoShelf) return false;

        const chip = [...discoShelf.querySelectorAll('[data-encore-id="chip"]')]
            .find(c => c.innerText === label);

        if (!chip) return false;

        chip.click();
        return true;

    }, chipLabel);

}

async function scrapeDiscographyCards() {

    return await page.evaluate(() => {

        const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];

        const discoShelf = shelves.find(s =>
            s.querySelector('[data-testid="rich-title-row-shelf-header"]')?.innerText.startsWith('Discographie')
        );

        const cards = [...discoShelf.querySelectorAll('[data-encore-id="card"]')];

        return cards.map(card => {

            const labelledBy = card.getAttribute('aria-labelledby') || "";
            const uriMatch = labelledBy.match(/spotify:(album|track):([a-zA-Z0-9]+)/);

            if (!uriMatch) return null;

            const titleEl = card.querySelector('[id^="card-title-"]');
            const subtitleEl = card.querySelector('[id^="card-subtitle-"]');
            const cover = card.querySelector('[data-testid="card-image"]')?.src || "";

            return {
                id: uriMatch[2],
                type: uriMatch[1],
                title: titleEl?.innerText || "",
                subtitle: subtitleEl?.innerText || "",
                cover
            };

        }).filter(Boolean);

    });

}

// transport commands go straight to Chromium's MPRIS interface over
// D-Bus instead of clicking DOM buttons through Playwright - Playwright
// is kept only for reading info and for actions with no MPRIS
// equivalent (opening the queue panel, browsing, etc.)
let mprisService = null;

async function findMprisService() {

    if (mprisService) return mprisService;

    const { stdout } = await execFileAsync("gdbus", [
        "call", "--session",
        "--dest", "org.freedesktop.DBus",
        "--object-path", "/org/freedesktop/DBus",
        "--method", "org.freedesktop.DBus.ListNames"
    ]);

    const match = stdout.match(/'(org\.mpris\.MediaPlayer2\.chromium\.[^']+)'/);

    mprisService = match ? match[1] : null;

    return mprisService;

}

async function mprisCommand(method) {

    const service = await findMprisService();

    if (!service) return false;

    try {

        await execFileAsync("gdbus", [
            "call", "--session",
            "--dest", service,
            "--object-path", "/org/mpris/MediaPlayer2",
            "--method", "org.mpris.MediaPlayer2.Player." + method
        ]);

        return true;

    } catch (e) {
        // chromium likely restarted under a new instance id - force
        // rediscovery on the next command
        mprisService = null;
        return false;
    }

}

async function connectSpotify() {
    const browser = await chromium.connectOverCDP(
        "http://127.0.0.1:9222"
    );

    const contexts = browser.contexts();
    const pages = contexts.flatMap(c => c.pages());

    // other tabs (e.g. left open from a browser-based `gh auth login`)
    // can outnumber or come before the Spotify one, so pick it out by
    // URL instead of assuming it's contexts[0].pages()[0]
    page = pages.find(p => p.url().includes("open.spotify.com")) || pages[0];

    console.log("Connected to Spotify:", await page.title());

    // keep references to the buttons
    controls.shuffle =
        page.locator('[data-testid="general-controls"] button').first();

    controls.repeat =
        page.getByTestId("control-button-repeat");

    controls.playPause =
        page.getByTestId("control-button-playpause");

    controls.next =
        page.getByTestId("control-button-skip-forward");

    controls.previous =
        page.getByTestId("control-button-skip-back");

    console.log("Spotify controls loaded");


}


// ---------------------------------------------------------------------
// Known personal quirks
//
// Workarounds for issues specific to this account's own Spotify content,
// not the app's logic.
// ---------------------------------------------------------------------

// on this account, some Spotify-side content (confirmed so far: one
// specific playlist, and separately "Titres likés") flips the whole web
// player to Arabic (sp_locale cookie set to "ar" by Spotify's own
// backend) as soon as it's opened - not something we can prevent, and
// not worth tracking down every id that triggers it, so this checks for
// it after every playlist load instead and silently fixes it whenever it
// happens
async function fixArabicLocaleBug() {
    await page.context().addCookies([{
        name: "sp_locale",
        value: "fr",
        domain: ".spotify.com",
        path: "/",
        expires: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 * 5,
        httpOnly: false,
        secure: true,
        sameSite: "None"
    }]);
    await page.reload({ waitUntil: "domcontentloaded" });
}

// the "ar" cookie doesn't always land the instant a playlist opens - it
// can show up a moment later, so a single check right after navigation
// isn't enough. Poll for a few seconds, and if it flips, fix it and watch
// again (the fix's own re-navigation can retrigger the same bug)
async function ensureFrenchLocale(id) {

    for (let attempt = 0; attempt < 2; attempt++) {

        let flipped = false;

        for (let i = 0; i < 6; i++) {
            const lang = await page.evaluate(() => document.documentElement.lang);
            if (lang !== "fr") { flipped = true; break; }
            await page.waitForTimeout(500);
        }

        if (!flipped) return;

        await fixArabicLocaleBug();
        await tryClickAnywhere(id);
        await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 8000 });

    }

}


// Chromium's MPRIS D-Bus service (org.mpris.MediaPlayer2.chromium.
// instanceXXXXX) is unreliable for roughly the first minute after a
// fresh Chromium/tab launch - it can be briefly unregistered while the
// tab's media session is still settling, so the first playpause of a
// session can find nothing to talk to over D-Bus and silently fail. A
// real click on Spotify's own button doesn't depend on that service at
// all (it's the same thing a manual mouse click does), so it's used as
// a fallback whenever MPRIS isn't there to answer
async function playPauseFallback() {
    await controls.playPause.click({ noWaitAfter: true });
    return true;
}

// gdbus can report success on a stale/idle MPRIS interface without any
// real effect - confirmed case: after the minimal session sits idle for
// a while, waking it (mouse/keyboard) leaves MPRIS commands acknowledged
// but silently no-op until a real click happens once. Catching that
// needs checking the button's state again a moment later, but the
// happy path (the vast majority of calls) is near-instant - so that
// check runs in the background *after* responding, instead of holding
// up every single call for it. A real, working MPRIS call has been
// observed to land in well under 100ms.
const SELF_HEAL_DELAY_MS = 100;

function selfHealPlayPauseIfUnchanged(before) {
    setTimeout(async () => {
        try {
            const after = await controls.playPause.getAttribute("aria-label");
            if (after === before) await playPauseFallback();
        } catch (e) { /* page navigated away or similar - nothing to heal */ }
    }, SELF_HEAL_DELAY_MS);
}

app.get("/playpause", async (req, res) => {

    const start = performance.now();

    const before = await controls.playPause.getAttribute("aria-label");
    let ok = await mprisCommand("PlayPause");
    if (!ok) ok = await playPauseFallback();

    const end = performance.now();

    console.log(
        "Playpause total:",
        (end - start).toFixed(2),
        "ms"
    );

    res.send(ok ? "ok" : "mpris unavailable");

    if (ok) selfHealPlayPauseIfUnchanged(before);
});

// Explicit (non-toggling) play/pause, for callers that know the state
// they want rather than just wanting to flip it (e.g.
// audiorelay-mpris-bridge.sh, reacting to AudioRelay's own connect/
// disconnect) - PlayPause's fallback above doesn't fit here since
// blindly clicking when already in the target state would flip it the
// wrong way instead of doing nothing. The fallback itself still matters
// here just as much: right after a fresh Chromium launch nothing has
// played yet, so Chromium hasn't registered its MPRIS interface at all,
// and mprisCommand() below would otherwise just fail silently until
// someone clicks play by hand once.
// Same "acknowledged but no real effect" gap as /playpause above - the
// target state is known here, so healing just means checking that state
// was actually reached, in the background, after responding.
function selfHealTowards(targetIsPlaying) {
    setTimeout(async () => {
        try {
            const isPlaying = (await controls.playPause.getAttribute("aria-label")) === "Pause";
            if (isPlaying !== targetIsPlaying) await controls.playPause.click({ noWaitAfter: true });
        } catch (e) { /* page navigated away or similar - nothing to heal */ }
    }, SELF_HEAL_DELAY_MS);
}

app.get("/play", async (req, res) => {
    let ok = await mprisCommand("Play");
    if (!ok) {
        const alreadyPlaying =
            (await controls.playPause.getAttribute("aria-label")) === "Pause";
        if (!alreadyPlaying) await controls.playPause.click({ noWaitAfter: true });
        ok = true;
    }
    res.send(ok ? "ok" : "mpris unavailable");

    selfHealTowards(true);
});

app.get("/pause", async (req, res) => {
    let ok = await mprisCommand("Pause");
    if (!ok) {
        const alreadyPlaying =
            (await controls.playPause.getAttribute("aria-label")) === "Pause";
        if (alreadyPlaying) await controls.playPause.click({ noWaitAfter: true });
        ok = true;
    }
    res.send(ok ? "ok" : "mpris unavailable");

    selfHealTowards(false);
});

app.get("/next", async (req, res) => {
    let ok = await mprisCommand("Next");
    if (!ok) ok = await controls.next.click({ noWaitAfter: true }).then(() => true);
    res.send(ok ? "ok" : "mpris unavailable");
});


app.get("/previous", async (req, res) => {
    let ok = await mprisCommand("Previous");
    if (!ok) ok = await controls.previous.click({ noWaitAfter: true }).then(() => true);
    res.send(ok ? "ok" : "mpris unavailable");
});


app.get("/shuffle", async (req, res) => {
    await controls.shuffle.click({
        noWaitAfter: true
    });
    res.send("ok");
});


app.get("/repeat", async (req, res) => {
    await controls.repeat.click({
        noWaitAfter: true
    });
    res.send("ok");
});

// the now-playing bar's context link always points to the track's
// album, even when playing from a playlist/radio/etc.; the queue
// panel's own heading ("À suivre dans : X") names the real context.
// Reading either this or the queue list itself requires the panel to
// be open, so both are read together here, only called when the
// client detects the track has actually changed (not on a fixed poll),
// rather than on every /state request. Left open afterwards rather
// than restored to closed - flipping it open/closed on every track
// change is more visually disruptive on the actual desktop screen
// than just leaving it open once opened
async function getContextAndQueue() {

    let list = await page.$('ul[aria-label="À suivre"]');

    if (!list) {
        await page.getByTestId("control-button-queue").click();
        await page.waitForSelector('ul[aria-label="À suivre"]', { timeout: 8000 });
    }

    const result = await page.evaluate(() => {

        function scrapeRows(list) {

            if (!list) return [];

            const rows = [...list.querySelectorAll('li[role="row"]')];

            return rows.map(row => {

                const titleEl = row.querySelector('[id^="listrow-title-"]');
                const subtitleEl = row.querySelector('[id^="listrow-subtitle-"]');
                const cover = row.querySelector('img')?.src || "";

                const artistLinks = [...(subtitleEl?.querySelectorAll('a') || [])];
                const subtitle = artistLinks.length
                    ? artistLinks.map(a => a.innerText).join(", ")
                    : (subtitleEl?.innerText || "");

                return { title: titleEl?.innerText || "", subtitle, cover };

            });

        }

        const list = document.querySelector('ul[aria-label="À suivre"]');
        if (!list) return { context: "", queue: [], manualQueue: [] };

        const headingText = list.previousElementSibling?.innerText || "";
        const match = headingText.match(/:\s*(.+)/);
        const context = match ? match[1].trim() : "";

        // manually-queued tracks ("Ajouter à la file d'attente") live in
        // their own separate list, distinct from this algorithmic
        // continuation - both are read together since both need the
        // panel open anyway
        const manualList = document.querySelector('ul[aria-label="À suivre dans la file d\'attente"]');

        return {
            context,
            queue: scrapeRows(list),
            manualQueue: scrapeRows(manualList)
        };

    });

    return result;

}

app.get("/state", async (req, res) => {

    const state = await page.evaluate(() => {

        const playButton =
            document.querySelector(
                '[data-testid="control-button-playpause"]'
            );


        const title =
            document.querySelector(
                '[data-testid="context-item-info-title"]'
            )?.innerText || "";

        const artist =
            document.querySelector(
                '[data-testid="context-item-info-artist"]'
            )?.innerText || "";


const position =
    document.querySelector(
        '[data-testid="playback-position"]'
    )?.innerText || "";

const duration =
    document.querySelector(
        '[data-testid="playback-duration"]'
    )?.innerText || "";

const cover =
    (document.querySelector(
        '[data-testid="cover-art-button"] img'
    )?.src || "").replace("ab67616d00004851", "ab67616d0000b273");

const shuffleButton =
    document.querySelector(
        '[data-testid="general-controls"] button'
    );

// no aria-checked/aria-pressed exposed on this button (unlike repeat
// below), so state has to be read from Spotify's own "active" color
// class instead of the language-dependent aria-label text
const shuffle =
    shuffleButton?.classList.contains("encore-internal-color-text-bright-accent") || false;

const repeatChecked =
    document.querySelector(
        '[data-testid="control-button-repeat"]'
    )?.getAttribute("aria-checked");

let repeat = "off";
if (repeatChecked === "true") repeat = "context";
else if (repeatChecked === "mixed") repeat = "track";

return {
    title,
    artist,
    playing:
        playButton?.getAttribute("aria-label") === "Pause",
    position,
    duration,
    cover,
    shuffle,
    repeat
};

});

    res.json(state);

});

app.get("/search", async (req, res) => {

    const query = req.query.q;

    if (!query) {
        return res.status(400).send("missing q");
    }

    try {

        const searchInput = page.getByTestId("search-input");

        await searchInput.click();
        await searchInput.fill(query);
        await page.keyboard.press("Enter");

        await page.waitForSelector('[data-testid="title"]', { timeout: 8000 });
        await waitForStableCount(page.locator('[data-testid="title"]'));

        const results = await page.evaluate(() => {

            const titleEls = [...document.querySelectorAll('[data-testid="title"]')];

            return titleEls.map(t => {

                const href = t.querySelector('a[href]')?.getAttribute('href');
                const match = href?.match(/\/(artist|album|track|playlist)\/([a-zA-Z0-9]+)/);

                if (!match) return null;

                let subtitleEl = null;
                let ancestor = t.parentElement;
                for (let d = 0; d < 4 && ancestor && !subtitleEl; d++) {
                    subtitleEl = ancestor.querySelector('[data-testid="subtitle"]');
                    ancestor = ancestor.parentElement;
                }

                let cover = "";
                let imgAncestor = t.parentElement;
                for (let d = 0; d < 5 && imgAncestor && !cover; d++) {
                    cover = imgAncestor.querySelector('img')?.src || "";
                    imgAncestor = imgAncestor.parentElement;
                }

                return {
                    id: match[2],
                    type: match[1],
                    title: t.innerText,
                    subtitle: subtitleEl?.innerText || "",
                    cover
                };

            }).filter(Boolean);

        });

        res.json(results);

    } catch (e) {
        console.error(e);
        res.status(500).send("search error");
    }

});

function scrapeWhatsNewRows() {

    return page.evaluate(() => {

        const rows = [...document.querySelectorAll(
            '[data-testid="infinite-scroll-list"] li[role="row"]'
        )];

        return rows.map(row => {

            const titleLink = row.querySelector('[data-encore-id="listRowTitle"] a[href]');
            if (!titleLink) return null;

            const href = titleLink.getAttribute('href');
            const match = href.match(/\/(artist|album|track|playlist)\/([a-zA-Z0-9]+)/);

            if (!match) return null;

            const subtitleEl = row.querySelector('[data-encore-id="listRowSubtitle"]');
            const artists = subtitleEl?.innerText || "";

            // "__bottom" (BEM suffix, tolerant of the hashed class
            // prefix changing across Spotify deploys - same trick as
            // [class*="YourLibraryX"] elsewhere) holds the release type
            // ("Single"/"Album") and a relative date ("il y a 2 jours")
            // that's sometimes in weeks/months instead - both nested
            // together with no separator in the raw text, so split the
            // date out first and rejoin cleanly
            const bottomEl = row.querySelector('[class*="__bottom"]');
            let releaseInfo = "";
            if (bottomEl) {
                const dateText = bottomEl.querySelector('span > span')?.textContent.trim() || "";
                const typeText = bottomEl.textContent.replace(dateText, "").trim();
                releaseInfo = [typeText, dateText].filter(Boolean).join(" · ");
            }

            return {
                id: match[2],
                type: match[1],
                title: titleLink.innerText,
                subtitle: artists,
                meta: releaseInfo,
                cover: row.querySelector('img')?.src || ""
            };

        }).filter(Boolean);

    });

}

// Unlike the library sidebar's virtualized rows, nothing here ever gets
// removed from the DOM once loaded - it's a plain paginated
// infinite-scroll: each real scroll near the bottom loads +10 more rows
// (confirmed: idle waiting alone, or setting scrollTop directly, does
// NOT trigger it - it needs an actual scroll/wheel event), up to a hard
// cap (observed 50, but not hardcoded here - just scroll until the
// count stops growing).
async function scrapeAllWhatsNewRows() {

    const rowLocator = page.locator('[data-testid="infinite-scroll-list"] li[role="row"]');

    await rowLocator.first().waitFor({ timeout: 8000 });

    const box = await page.locator('[data-testid="infinite-scroll-list"]').boundingBox();
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + 50);

    let lastCount = await rowLocator.count();

    for (let i = 0; i < 20; i++) {

        await page.mouse.wheel(0, 3000);
        await page.waitForTimeout(500);

        const count = await rowLocator.count();

        if (count === lastCount) break;

        lastCount = count;

    }

    return await scrapeWhatsNewRows();

}

// "Nouveautés" - new releases from followed artists/podcasts. Same
// scraped shape as /search ({id, type, title, subtitle, cover}) so the
// existing result rendering/click-to-play on the client works unchanged.
// The "Musique" tab is Spotify's default here, so only album/track/
// artist/playlist links show up - podcast episodes (a separate tab)
// aren't covered yet, same as /search already only handles those types.
app.get("/whats-new", async (req, res) => {

    try {

        // The button toggles the view - clicking it while already there
        // closes it and navigates back, so only click when needed
        if (!page.url().includes("/content-feed")) {
            await page.click('[data-testid="whats-new-feed-button"]');
        }

        const results = await scrapeAllWhatsNewRows();

        res.json(results);

    } catch (e) {
        console.error(e);
        res.status(500).send("whats-new error");
    }

});

async function tryClickPlayableElement(id) {

    return await page.evaluate((id) => {

        const link = document.querySelector(`a[href*="/${id}"]`)
            || document.querySelector(`[aria-labelledby*="${id}"]`);

        if (!link) return false;

        let ancestor = link;

        for (let d = 0; d < 6 && ancestor; d++) {

            const buttons = [...ancestor.querySelectorAll('button')];

            const playBtn = buttons.find(b =>
                b.getAttribute('data-testid') === 'play-button' ||
                b.getAttribute('aria-label')?.startsWith('Lire') ||
                b.getAttribute('aria-label') === 'Lecture'
            );

            if (playBtn) {
                playBtn.click();
                return true;
            }

            // a Pause button this close to the link means this row IS
            // already the currently playing track; stop here instead of
            // climbing further and grabbing an unrelated row's button
            const pauseBtn = buttons.find(b =>
                b.getAttribute('aria-label')?.startsWith('Mettre en pause') ||
                b.getAttribute('aria-label') === 'Pause'
            );

            if (pauseBtn) return true;

            ancestor = ancestor.parentElement;

        }

        return false;

    }, id);

}

// same row-widening walk-up as tryClickPlayableElement, but opens the
// "more options" menu and picks the queue entry instead of pressing
// play - the menu item has no stable testid/attribute, only its French
// label, same tradeoff as the other Spotify-rendered-text matches
// elsewhere in this file (see the README's language dependency note)
async function tryAddToQueue(id) {

    const opened = await page.evaluate((id) => {

        const link = document.querySelector(`a[href*="/${id}"]`)
            || document.querySelector(`[aria-labelledby*="${id}"]`);

        if (!link) return false;

        let ancestor = link;

        for (let d = 0; d < 6 && ancestor; d++) {

            const moreBtn = [...ancestor.querySelectorAll('button')].find(b =>
                b.getAttribute('data-testid') === 'more-button'
            );

            if (moreBtn) {
                moreBtn.click();
                return true;
            }

            ancestor = ancestor.parentElement;

        }

        return false;

    }, id);

    if (!opened) return false;

    await page.waitForSelector('[role="menu"]', { timeout: 3000 }).catch(() => {});

    const clicked = await page.evaluate(() => {

        const menu = document.querySelector('[role="menu"]');
        if (!menu) return false;

        const item = [...menu.querySelectorAll('[role="menuitem"]')].find(i =>
            i.innerText.trim() === "Ajouter à la file d'attente"
        );

        if (!item) return false;

        item.click();
        return true;

    });

    // don't leave a stray open menu behind if the item wasn't found
    // (e.g. this row turned out not to be a track)
    if (!clicked) await page.keyboard.press("Escape").catch(() => {});

    return clicked;

}

async function scrollTracklistToTop() {

    await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (container) container.scrollTop = 0;

    });

}

async function scrollTracklistToFraction(fraction) {

    return await page.evaluate((fraction) => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (!container) return false;

        const totalRange = container.scrollHeight - container.clientHeight;
        container.scrollTop = totalRange * fraction;

        return true;

    }, fraction);

}

// right after the initial batch is shown, pre-position the scrollbar so
// the next unseen row is already the first one visible - if "Charger
// plus" gets tapped later, the forward PageDown scan can start from here
// instead of re-covering the rows already sent in the first batch
async function positionTracklistAfterInitialBatch(rowCount) {

    return await page.evaluate((rowCount) => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (!container || !row) return false;

        const rowHeight = row.getBoundingClientRect().height;
        const totalRange = container.scrollHeight - container.clientHeight;

        container.scrollTop = Math.min(rowCount * rowHeight, totalRange);

        return true;

    }, rowCount);

}

// steps through a virtualized list with real PageUp/PageDown key
// presses, checking for the target after every press so the scan
// stops the moment it's found - shared by every "the tap missed a
// virtualized-out target" search fallback (tracklist/library
// sidebar/discography grid), which only differ in how the list gets
// keyboard focus
async function pageStepUntilFound(focusFn, clickFn, direction, getScrollTop) {

    if (await clickFn()) return true;

    if (!(await focusFn())) return false;

    const key = direction === "up" ? "PageUp" : "PageDown";
    const maxPresses = 40;

    let lastScrollTop = await getScrollTop();

    for (let i = 0; i < maxPresses; i++) {

        await page.keyboard.press(key);
        await page.waitForTimeout(350);

        if (await clickFn()) return true;

        // hit the top/bottom of the list - nothing further to reveal
        const scrollTop = await getScrollTop();
        if (scrollTop === lastScrollTop) break;
        lastScrollTop = scrollTop;

    }

    return false;

}

// the client already knows roughly where the tapped track sits
// relative to the center position "Charger plus" leaves the cursor
// at, so it tells us which way to look. Clicking the column header
// row gives real keyboard focus without risking triggering playback,
// same trick as the "Charger plus" scan. clickFn is pluggable (play,
// add to queue, ...) - only what happens once the row is found differs
async function scrollToFindAndClick(clickFn, direction) {

    return pageStepUntilFound(async () => {

        const headerHandle = await page.evaluateHandle(() => {

            function findScrollable(el) {
                while (el && el !== document.body) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }

            const row = document.querySelector('[data-testid="tracklist-row"]');
            const container = row ? findScrollable(row) : null;

            return container ? container.querySelector('[role="row"]') : null;

        });

        const headerEl = headerHandle.asElement();
        const focused = !!headerEl;
        if (headerEl) await headerEl.click({ timeout: 3000 }).catch(() => {});
        await headerHandle.dispose();

        return focused;

    }, clickFn, direction, async () => {
        const info = await currentTracklistScrollInfo();
        return info ? info.scrollTop : null;
    });

}

app.get("/play-result", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let clicked = await tryClickPlayableElement(id);

        if (!clicked) {
            clicked = await scrollToFindAndClick(() => tryClickPlayableElement(id), direction);
        }

        if (!clicked) {
            return res.status(404).send("not found");
        }

        res.send("ok");

    } catch (e) {
        console.error(e);
        res.status(500).send("play error");
    }

});

app.get("/queue-add", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let added = await tryAddToQueue(id);

        if (!added) {
            added = await scrollToFindAndClick(() => tryAddToQueue(id), direction);
        }

        if (!added) {
            return res.status(404).send("not found");
        }

        res.send("ok");

    } catch (e) {
        console.error(e);
        res.status(500).send("queue-add error");
    }

});

async function scrollArtistDiscographyToFraction(fraction) {

    return await page.evaluate((fraction) => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
        const container = card ? findScrollable(card) : null;

        if (!container) return false;

        container.scrollTop = (container.scrollHeight - container.clientHeight) * fraction;
        return true;

    }, fraction);

}

async function currentDiscographyScrollInfo() {

    return await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
        const container = card ? findScrollable(card) : null;

        if (!container) return null;

        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight
        };

    });

}

// same "virtualized out of the grid" problem as the library sidebar
// list has, but scoped to the artist's own discography grid instead -
// only meaningful on an artist page, so it self-guards on the missing
// container the same way clickDiscographyChip does, and can safely be
// tried even when the tap actually came from the library
async function scrollDiscographyAndRetryClick(clickFn, direction) {

    return pageStepUntilFound(async () => {

        return await page.evaluate(() => {

            function findScrollable(el) {
                while (el && el !== document.body) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }

            const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
            const container = card ? findScrollable(card) : null;

            if (!container) return false;

            if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
            container.focus();

            return document.activeElement === container;

        });

    }, clickFn, direction, async () => {
        const info = await currentDiscographyScrollInfo();
        return info ? info.scrollTop : null;
    });

}

function scrapeDiscographyCardsInView() {

    return page.evaluate(() => {

        const main = document.querySelector('[data-testid="artist-page"]') || document.body;
        const cards = [...main.querySelectorAll('[data-encore-id="card"]')];

        return cards.map(card => {

            const labelledBy = card.getAttribute('aria-labelledby') || "";
            const uriMatch = labelledBy.match(/spotify:(album|track):([a-zA-Z0-9]+)/);

            if (!uriMatch) return null;

            const titleEl = card.querySelector('[id^="card-title-"]');
            const subtitleEl = card.querySelector('[id^="card-subtitle-"]');
            const cover = card.querySelector('[data-testid="card-image"]')?.src || "";

            return {
                id: uriMatch[2],
                type: uriMatch[1],
                title: titleEl?.innerText || "",
                subtitle: subtitleEl?.innerText || "",
                cover
            };

        }).filter(Boolean);

    });

}

// the discography grid is virtualized, so a single scrape only ever
// sees a partial window - scrape the top (the "first render" sent
// back immediately), then jump to the bottom and work upward with the
// grid's own PageUp handling (already tuned to move exactly one
// screenful with no gaps) until the cards seen overlap with the top
// batch, at which point everything in between has been captured. This
// needs no knowledge of the scrollable range or its size, unlike a
// fixed-fraction sweep (tried first, but found to unreliably drop a
// chunk of cards on large discographies)
// how many cards the grid renders on first paint with no scrolling at
// all, measured empirically on artists with large discographies (Bob
// Dylan, Neil Young - both landed on exactly this number, regardless
// of content, so it's a property of the render buffer/viewport size,
// not of any particular artist). A discography whose first render
// comes in under this is necessarily showing everything already - if
// there were more, the buffer would have rendered up to this many
const INITIAL_RENDER_CAPACITY = 49;

async function scrapeAllDiscographyCards(onFirstRender) {

    await scrollArtistDiscographyToFraction(0);
    await page.waitForTimeout(300);

    const initialCards = await scrapeDiscographyCardsInView();

    const initialIds = new Set(initialCards.map(c => c.id));
    const collected = new Map();
    for (const card of initialCards) collected.set(card.id, card);

    if (initialCards.length < INITIAL_RENDER_CAPACITY) {
        if (onFirstRender) onFirstRender(initialCards, true);
        return [...collected.values()];
    }

    const focused = await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const card = document.querySelector('[data-testid="artist-page"] [data-encore-id="card"]');
        const container = card ? findScrollable(card) : null;

        if (!container) return false;

        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();

        return document.activeElement === container;

    });

    // nothing to scroll - the first batch is already the whole
    // discography, so there's no second, fuller result coming
    if (!focused) {
        if (onFirstRender) onFirstRender(initialCards, true);
        return [...collected.values()];
    }

    // jump to the bottom with the real End key rather than setting
    // scrollTop directly, for the same reason as the playlist scan:
    // consistent with how PageUp is done below, one mechanism throughout
    await page.keyboard.press("End");
    await page.waitForTimeout(600);

    // the container can be "scrollable" purely because of page chrome
    // below the grid (the Spotify footer, mainly) with no extra cards
    // in it at all - check what's actually at the bottom before
    // deciding a second, fuller result is coming
    const bottomCards = await scrapeDiscographyCardsInView();
    const hasNewCards = bottomCards.some(c => !initialIds.has(c.id));

    if (!hasNewCards) {
        if (onFirstRender) onFirstRender(initialCards, true);
        return [...collected.values()];
    }

    if (onFirstRender) onFirstRender(initialCards, false);

    for (const card of bottomCards) collected.set(card.id, card);

    const alreadyOverlapping = bottomCards.some(c => initialIds.has(c.id));

    if (!alreadyOverlapping) {

        const maxPageUps = 40;
        let pageUps = 0;

        while (pageUps < maxPageUps) {

            await page.keyboard.press("PageUp");
            await page.waitForTimeout(350);

            const cards = await scrapeDiscographyCardsInView();
            const hasOverlap = cards.some(c => initialIds.has(c.id));

            for (const card of cards) collected.set(card.id, card);

            if (hasOverlap) break;

            pageUps++;

        }

    }

    return [...collected.values()];

}

function categorizeReleases(releases) {

    const getYear = (r) => {
        const match = r.subtitle?.match(/\d{4}/);
        return match ? Number(match[0]) : Infinity;
    };

    const albums = releases
        .filter(r => r.subtitle?.includes('Album') || r.subtitle?.includes('EP'))
        .sort((a, b) => getYear(b) - getYear(a));

    const singles = releases
        .filter(r => r.subtitle?.includes('Single'))
        .sort((a, b) => getYear(b) - getYear(a));

    const compilations = releases
        .filter(r => r.subtitle?.includes('Compilation'))
        .sort((a, b) => getYear(b) - getYear(a));

    return { albums, singles, compilations };

}

async function scrapeArtistDiscography(onFirstRender) {

    await page.waitForSelector('[data-testid="component-shelf"]', { timeout: 8000 });

    const seeAllClicked = await page.evaluate(() => {
        const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];
        const discoShelf = shelves.find(s =>
            s.querySelector('[data-testid="rich-title-row-shelf-header"]')?.innerText.startsWith('Discographie')
        );
        const seeAll = discoShelf?.querySelector('[data-testid="see-all-link"]');
        if (!seeAll) return false;
        seeAll.click();
        return true;
    });

    if (!seeAllClicked) {
        throw new Error("discography not found");
    }

    await page.waitForSelector(
        '[data-testid="artist-page"] button[aria-controls="sort-and-view-picker"]',
        { timeout: 8000 }
    );

    await page.locator(
        '[data-testid="artist-page"] button[aria-controls="sort-and-view-picker"]'
    ).click();

    await page.waitForTimeout(400);

    await page.evaluate(() => {
        const menus = [...document.querySelectorAll('[role="menu"]')];
        const viewMenu = menus.find(m => m.innerText.includes("Mode d'affichage"));
        const btn = [...(viewMenu?.querySelectorAll('button, [role="menuitemradio"]') || [])]
            .find(o => o.innerText.trim() === 'Grille');
        btn?.click();
    });

    await page.waitForSelector('[data-encore-id="card"]', { timeout: 8000 });
    await page.waitForTimeout(1000);

    // the right-hand "En cours de lecture" panel eats into the grid's
    // width when open - closing it lets more cards fit per row, so
    // fewer scroll stops are needed to cover the whole discography;
    // checked here (once the grid has settled) rather than right after
    // the "voir tout" click, since the panel's state right after a
    // route transition doesn't reflect what's actually on screen -
    // and the panel is closed by sliding it off-screen, leaving only a
    // narrow collapsed tab overlapping the viewport edge - so presence
    // and a plain overlap check both misread that as "open". Selected
    // by id, not class - its class list changes depending on whether
    // it's showing the queue or the "now playing" view, but the id
    // stays constant either way
    const isRightPanelOnScreen = () => page.evaluate(() => {
        const aside = document.getElementById('Desktop_PanelContainer_Id');
        if (!aside) return false;
        const r = aside.getBoundingClientRect();
        const visibleWidth = Math.min(r.right, window.innerWidth) - Math.max(r.x, 0);
        return visibleWidth > r.width * 0.5;
    });

    if (await isRightPanelOnScreen()) {

        // if it's showing the queue, closing it needs the queue button;
        // the "Masquer la vue En cours de lecture" button only shows up
        // once the queue view itself is closed
        const showingQueue = await page.evaluate(() => !!document.querySelector('ul[aria-label="À suivre"]'));
        if (showingQueue) {
            await page.getByTestId("control-button-queue").click();
            await page.waitForTimeout(500);
        }

        if (await isRightPanelOnScreen()) {
            await page.evaluate(() => {
                const btn = [...document.querySelectorAll('button')].find(b =>
                    (b.getAttribute('aria-label') || "").includes('Masquer la vue')
                );
                btn?.click();
            });
            await page.waitForTimeout(500);
        }

    }

    let wasComplete = false;

    const releases = await scrapeAllDiscographyCards((initialCards, isComplete) => {
        wasComplete = isComplete;
        if (onFirstRender) onFirstRender(categorizeReleases(initialCards), isComplete);
    });

    // the 2/3 resting position is meant to leave room for a future
    // direction-based search fallback on a long, virtualized list - a
    // short discography that was already complete on the first render
    // has nothing virtualized to find, so jumping there would just be
    // a pointless extra scroll
    if (!wasComplete) {
        await scrollArtistDiscographyToFraction(2 / 3);
    }

    return categorizeReleases(releases);

}

app.get("/artist", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let navigated = await tryClickAnywhere(id);

        if (!navigated) {
            navigated = await scrollLibraryAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForTimeout(2500);

        res.setHeader("Content-Type", "application/x-ndjson");

        let sentComplete = false;

        const combined = await scrapeArtistDiscography((firstRender, isComplete) => {
            sentComplete = isComplete;
            res.write(JSON.stringify({ ...firstRender, done: isComplete }) + "\n");
        });

        if (!sentComplete) {
            res.write(JSON.stringify({ ...combined, done: true }) + "\n");
        }
        res.end();

    } catch (e) {
        console.error(e);
        if (res.headersSent) {
            res.end();
            return;
        }
        if (e.message === "discography not found") {
            return res.status(404).send("discography not found");
        }
        res.status(500).send("artist error");
    }

});

app.get("/current-artist", async (req, res) => {

    try {

        const navigated = await page.evaluate(() => {
            const container = document.querySelector(
                '[data-testid="context-item-info-artist"]'
            );
            const link = container?.matches('a[href*="/artist/"]')
                ? container
                : container?.querySelector('a[href*="/artist/"]');
            if (!link) return false;
            link.click();
            return true;
        });

        if (!navigated) {
            return res.status(404).send("not found");
        }

        res.setHeader("Content-Type", "application/x-ndjson");

        let sentComplete = false;

        const combined = await scrapeArtistDiscography((firstRender, isComplete) => {
            sentComplete = isComplete;
            res.write(JSON.stringify({ ...firstRender, done: isComplete }) + "\n");
        });

        if (!sentComplete) {
            res.write(JSON.stringify({ ...combined, done: true }) + "\n");
        }
        res.end();

    } catch (e) {
        console.error(e);
        if (res.headersSent) {
            res.end();
            return;
        }
        if (e.message === "discography not found") {
            return res.status(404).send("discography not found");
        }
        res.status(500).send("artist error");
    }

});

async function navigateToCurrentAlbum() {

    return await page.evaluate(() => {
        const contextLink = document.querySelector('[data-testid="context-item-link"]');
        if (!contextLink) return false;
        contextLink.click();
        return true;
    });

}

app.get("/current-album-name", async (req, res) => {

    try {

        const navigated = await navigateToCurrentAlbum();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="entityTitle"] h1', { timeout: 8000 });

        const name = await page.evaluate(() => {
            const h1 = document.querySelector('[data-testid="entityTitle"] h1');
            return h1?.innerText || "";
        });

        res.json({ name });

    } catch (e) {
        console.error(e);
        res.status(500).send("album name error");
    }

});

app.get("/current-album", async (req, res) => {

    try {

        const navigated = await navigateToCurrentAlbum();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        const results = await scrapeAlbumTracklist();

        res.json(results);

    } catch (e) {
        console.error(e);
        res.status(500).send("album error");
    }

});

async function navigateHome() {

    return await page.evaluate(() => {
        const home = document.querySelector('[data-testid="home-button"]')
            || document.querySelector('a[href="/"]');
        if (!home) return false;
        home.click();
        return true;
    });

}

app.get("/home", async (req, res) => {

    try {

        const navigated = await navigateHome();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="component-shelf"]', { timeout: 8000 });
        await waitForStableCount(page.locator('[data-testid="component-shelf"]'));

        const headings = await page.evaluate(() => {

            const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];

            return shelves
                .map(shelf => shelf.querySelector('[data-testid="rich-title-row-shelf-header"] h2')?.innerText || "")
                .filter(Boolean);

        });

        res.json(headings.map(heading => ({ heading })));

    } catch (e) {
        console.error(e);
        res.status(500).send("home error");
    }

});

app.get("/home-section", async (req, res) => {

    try {

        const index = Number(req.query.index);

        const navigated = await navigateHome();

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="component-shelf"]', { timeout: 8000 });
        await waitForStableCount(page.locator('[data-testid="component-shelf"]'));

        const items = await page.evaluate((index) => {

            const shelves = [...document.querySelectorAll('[data-testid="component-shelf"]')];

            const shelvesWithHeading = shelves.filter(shelf =>
                shelf.querySelector('[data-testid="rich-title-row-shelf-header"] h2')?.innerText
            );

            const shelf = shelvesWithHeading[index];

            if (!shelf) return [];

            const cards = [...shelf.querySelectorAll('[data-encore-id="card"]')];

            return cards.map(card => {

                const labelledBy = card.getAttribute('aria-labelledby') || "";
                const uriMatch = labelledBy.match(/spotify:(album|track|artist|playlist|show|episode):([a-zA-Z0-9]+)/);

                if (!uriMatch) return null;

                const titleEl = card.querySelector('[id^="card-title-"]');
                const subtitleEl = card.querySelector('[id^="card-subtitle-"]');
                const cover = card.querySelector('[data-testid="card-image"]')?.src
                    || card.querySelector('img')?.src || "";

                return {
                    id: uriMatch[2],
                    type: uriMatch[1],
                    title: titleEl?.innerText || "",
                    subtitle: subtitleEl?.innerText || "",
                    cover
                };

            }).filter(Boolean);

        }, index);

        res.json(items);

    } catch (e) {
        console.error(e);
        res.status(500).send("home section error");
    }

});

// the scrollable area extends past the last real track (padding,
// recommended-tracks section, etc.), so waiting for the scroll position
// to reach the bottom means a couple of extra empty page-downs after
// the last track is already loaded; aria-rowindex/aria-rowcount give
// the real position within the playlist instead
async function isAtLastTrack() {

    return await page.evaluate(() => {

        const rows = [...document.querySelectorAll('[data-testid="tracklist-row"]')];

        if (!rows.length) return false;

        const grid = rows[0].closest('[role="grid"][aria-rowcount]');
        const rowcount = Number(grid?.getAttribute("aria-rowcount"));

        if (!rowcount) return false;

        const indices = rows.map(row => {
            const rowParent = row.closest('[role="row"]');
            return rowParent ? Number(rowParent.getAttribute("aria-rowindex")) : null;
        }).filter(n => n !== null);

        if (!indices.length) return false;

        return Math.max(...indices) >= rowcount;

    });

}

async function scrapeVisibleTracklistRows() {

    return await page.evaluate(() => {

        const rows = [...document.querySelectorAll('[data-testid="tracklist-row"]')]
            .filter(row => !row.closest('[data-testid="recommended-track"]'));

        return rows.map(row => {

            const link = row.querySelector('a[href*="/track/"]');

            if (!link) return null;

            const artistLinks = [...row.querySelectorAll('a[href*="/artist/"]')];
            const cover = row.querySelector('img')?.src || "";

            const rowParent = row.closest('[role="row"]');
            const rowIndex = rowParent ? Number(rowParent.getAttribute("aria-rowindex")) : null;

            const grid = row.closest('[role="grid"][aria-rowcount]');
            const rowCount = grid ? Number(grid.getAttribute("aria-rowcount")) : null;

            return {
                id: link.getAttribute('href').split('/track/')[1],
                type: "track",
                title: link.innerText,
                subtitle: artistLinks.map(a => a.innerText).join(", "),
                cover,
                rowIndex,
                rowCount
            };

        }).filter(Boolean);

    });

}

// albums are short enough to never need the scroll-and-accumulate pass
// below (built for long playlists); scrolling the real page for them
// is pure wasted motion, so just grab whatever is already rendered
async function scrapeAlbumTracklist() {

    await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 8000 });
    await waitForStableCount(page.locator('[data-testid="tracklist-row"]'));

    return await scrapeVisibleTracklistRows();

}

app.get("/album", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let navigated = await tryClickAnywhere(id);

        if (!navigated && await clickDiscographyChip('Albums')) {
            await page.waitForTimeout(500);
            navigated = await tryClickAnywhere(id);
        }

        if (!navigated && await clickDiscographyChip('Singles et EP')) {
            await page.waitForTimeout(500);
            navigated = await tryClickAnywhere(id);
        }

        // the tap can come from either the artist's own discography grid
        // or the library sidebar - try the grid-scoped scan first (it
        // self-guards to a no-op if there's no artist page to scan),
        // then fall back to the sidebar
        if (!navigated) {
            navigated = await scrollDiscographyAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            navigated = await scrollLibraryAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            return res.status(404).send("not found");
        }

        const results = await scrapeAlbumTracklist();

        res.json(results);

    } catch (e) {
        console.error(e);
        res.status(500).send("album error");
    }

});

async function selectLibraryChip(type) {

    const label = { playlists: "Playlists", artists: "Artistes", albums: "Albums" }[type];

    if (!label) return false;

    // the chips (Playlists/Artistes/Albums) aren't shown at all while
    // inside a folder - back out first if needed. Checked here rather
    // than trusted from the client, since the sidebar's own navigation
    // state persists independently of the remote page's lifecycle (a
    // page reload doesn't reset it)
    const inFolder = await page.evaluate(() => {
        const lib = document.querySelector('[class*="YourLibraryX"]');
        return !![...(lib?.querySelectorAll("button") || [])].find(b => b.getAttribute("aria-label") === "Retour");
    });

    if (inFolder) {
        await page.evaluate(() => {
            const lib = document.querySelector('[class*="YourLibraryX"]');
            const back = [...(lib?.querySelectorAll("button") || [])].find(b => b.getAttribute("aria-label") === "Retour");
            back?.click();
        });
        await page.waitForTimeout(600);
    }

    async function clickChip() {
        return await page.evaluate((label) => {
            const lib = document.querySelector('[class*="YourLibraryX"]');
            const chip = lib
                ? [...lib.querySelectorAll('[data-encore-id="chip"]')].find(c => c.getAttribute("aria-label") === label)
                : null;
            if (!chip) return false;
            // clicking an already-active chip toggles it back off
            if (chip.getAttribute("aria-checked") !== "true") chip.click();
            return true;
        }, label);
    }

    if (await clickChip()) return true;

    // the chip row collapses to just the active filter once one is
    // selected; deselect it first to bring the full chip row back
    await page.evaluate(() => {
        const lib = document.querySelector('[class*="YourLibraryX"]');
        const active = lib
            ? [...lib.querySelectorAll('[data-encore-id="chip"]')].find(c => c.getAttribute("aria-checked") === "true")
            : null;
        active?.click();
    });

    await page.waitForTimeout(600);

    return await clickChip();

}

async function scrollLibraryToTop() {

    await page.evaluate(() => {
        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');
        if (container) container.scrollTop = 0;
    });

}

async function scrollLibraryToFraction(fraction) {

    return await page.evaluate((fraction) => {

        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

        if (!container) return false;

        container.scrollTop = (container.scrollHeight - container.clientHeight) * fraction;

        return true;

    }, fraction);

}

async function tryClickAnywhere(id) {

    return await page.evaluate((id) => {

        const target = document.querySelector(`a[href*="/${id}"]`)
            || document.querySelector(`[role="button"][aria-labelledby*="${id}"]`);

        if (!target) return false;

        target.click();
        return true;

    }, id);

}

// same "id could be virtualized out of the sidebar" problem as long
// playlists have, for library items (playlist/artist/album cards
// found via the sidebar's "Charger plus" scan) - same fix: the client
// says which half of the loaded list it was in, we page toward it
// with real PageUp/PageDown presses and retry the click after each
async function scrollLibraryAndRetryClick(clickFn, direction) {

    return pageStepUntilFound(async () => {

        return await page.evaluate(() => {

            const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

            if (!container) return false;

            if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
            container.focus();

            return document.activeElement === container;

        });

    }, clickFn, direction, async () => {
        const info = await currentLibraryScrollInfo();
        return info ? info.scrollTop : null;
    });

}

async function currentLibraryScrollInfo() {

    return await page.evaluate(() => {

        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

        if (!container) return null;

        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight
        };

    });

}

async function scrapeVisibleLibraryRows() {

    return await page.evaluate((folderIcon) => {

        const lib = document.querySelector('[class*="YourLibraryX"]');

        if (!lib) return [];

        const rows = [...lib.querySelectorAll('[role="row"]')];

        return rows.map(row => {

            const rowIndex = parseInt(row.getAttribute("aria-rowindex"), 10) || 0;

            const listRow = row.querySelector('[data-encore-id="listRow"]');
            const labelledBy = listRow?.getAttribute("aria-labelledby") || "";
            const titleEl = document.getElementById(labelledBy);

            const folderMatch = labelledBy.match(/folder:([a-zA-Z0-9]+)$/);

            if (folderMatch) {
                return {
                    id: folderMatch[1],
                    type: "folder",
                    title: titleEl?.innerText || "",
                    subtitle: "",
                    cover: folderIcon,
                    rowIndex
                };
            }

            // "Titres likés" isn't a real playlist - it's a special
            // spotify:collection:tracks entity with no href, only a
            // role="button" whose aria-labelledby contains this id
            if (labelledBy.includes("collection:tracks")) {
                return {
                    id: "collection:tracks",
                    type: "playlist",
                    title: titleEl?.innerText || "",
                    subtitle: "",
                    cover: row.querySelector("img")?.src || "",
                    rowIndex
                };
            }

            const uriMatch = labelledBy.match(/spotify:(playlist|artist|album):([a-zA-Z0-9]+)$/);

            if (!uriMatch) return null;

            const subtitleEl = document.getElementById(labelledBy.replace("listrow-title-", "listrow-subtitle-"));
            const cover = row.querySelector("img")?.src || "";

            return {
                id: uriMatch[2],
                type: uriMatch[1],
                title: titleEl?.innerText || "",
                subtitle: subtitleEl?.innerText || "",
                cover,
                rowIndex
            };

        }).filter(Boolean);

    }, FOLDER_ICON);

}

// same virtualization problem as the discography grid, so the same
// fix, ported directly: scrape the top batch, focus the list and jump
// to the bottom with the real End key, then walk back up with PageUp
// until the rows seen overlap with the top batch - at that point
// everything in between has been captured. Library rows aren't
// playback-ordered like tracklist rows, so the discography's simpler
// any-overlap stop is safe here too, no need for the exact-count
// approach playlists needed
async function scrapeAllLibraryRows() {

    await scrollLibraryToTop();
    await page.waitForTimeout(300);

    const initialRows = await scrapeVisibleLibraryRows();

    const initialIds = new Set(initialRows.map(r => r.id));
    const collected = new Map();
    for (const row of initialRows) collected.set(row.id, row);

    // scan order jumbles top/bottom/middle batches together - the real
    // sidebar position (aria-rowindex) is the only thing that reflects
    // true list order, same fix as the playlist scan
    const ordered = () => [...collected.values()].sort((a, b) => a.rowIndex - b.rowIndex);

    const focused = await page.evaluate(() => {

        const container = document.querySelector('[class*="YourLibraryX"] [data-overlayscrollbars-viewport]');

        if (!container) return false;

        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus();

        return document.activeElement === container;

    });

    // nothing to scroll - the first batch is already the whole list
    if (!focused) return ordered();

    await page.keyboard.press("End");
    await page.waitForTimeout(600);

    const bottomRows = await scrapeVisibleLibraryRows();
    const hasNewRows = bottomRows.some(r => !initialIds.has(r.id));

    // the container was "scrollable" but nothing new showed up at the
    // bottom (e.g. page chrome below the list) - already complete
    if (!hasNewRows) return ordered();

    for (const row of bottomRows) collected.set(row.id, row);

    const alreadyOverlapping = bottomRows.some(r => initialIds.has(r.id));

    if (!alreadyOverlapping) {

        const maxPageUps = 40;
        let pageUps = 0;

        while (pageUps < maxPageUps) {

            await page.keyboard.press("PageUp");
            await page.waitForTimeout(350);

            const rows = await scrapeVisibleLibraryRows();
            const hasOverlap = rows.some(r => initialIds.has(r.id));

            for (const row of rows) collected.set(row.id, row);

            if (hasOverlap) break;

            pageUps++;

        }

    }

    return ordered();

}

async function currentTracklistScrollInfo() {

    return await page.evaluate(() => {

        function findScrollable(el) {
            while (el && el !== document.body) {
                const style = getComputedStyle(el);
                if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                    return el;
                }
                el = el.parentElement;
            }
            return null;
        }

        const row = document.querySelector('[data-testid="tracklist-row"]');
        const container = row ? findScrollable(row) : null;

        if (!container) return null;

        return {
            scrollTop: container.scrollTop,
            scrollHeight: container.scrollHeight,
            clientHeight: container.clientHeight
        };

    });

}

async function getPlaylistTrackCount() {

    return await page.evaluate(() => {

        const container = document.querySelector('[data-testid="playlist-page"]');
        if (!container) return null;

        const span = [...container.querySelectorAll('span')].find(el =>
            el.children.length === 0 && /^\d[\d\s ]*\s*(titre|chanson)/i.test(el.textContent.trim())
        );

        if (!span) return null;

        const digits = span.textContent.replace(/[^\d]/g, '');
        return digits ? parseInt(digits, 10) : null;

    });

}

// playlists can be far too long to scan in full, and doing so leaves
// the real page scrolled away from earlier tracks (breaking playback
// for them); instead this pages through in coarse steps, mirroring
// whatever chunk the remote is currently showing
app.get("/playlist", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let navigated = await tryClickAnywhere(id);

        if (!navigated) {
            navigated = await scrollLibraryAndRetryClick(() => tryClickAnywhere(id), direction);
        }

        if (!navigated) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[data-testid="tracklist-row"]', { timeout: 8000 });

        await ensureFrenchLocale(id);

        await waitForStableCount(page.locator('[data-testid="tracklist-row"]'));

        await scrollTracklistToTop();
        await page.waitForTimeout(300);

        const tracks = await scrapeVisibleTracklistRows();
        const scrollInfo = await currentTracklistScrollInfo();
        const lastTrackLoaded = await isAtLastTrack();

        const atBottom = lastTrackLoaded || (scrollInfo ? (scrollInfo.scrollTop + scrollInfo.clientHeight >= scrollInfo.scrollHeight - 2) : true);

        lastPlaylistInitialTracks = atBottom ? [] : tracks;

        res.json({
            tracks,
            atTop: true,
            atBottom
        });

        // purely prepares the next "Charger plus" call - the remote
        // already has its answer, this shouldn't delay it. Response is
        // already sent, so failures here are just logged, not reported
        if (!atBottom) {
            try {
                await positionTracklistAfterInitialBatch(tracks.length);
            } catch (e) {
                console.error("positionTracklistAfterInitialBatch failed:", e);
            }
        }

    } catch (e) {
        console.error(e);
        res.status(500).send("playlist error");
    }

});

// manual "load more" for long playlists: jump to the bottom with the
// real End key, then work back upward with
// PageUp, scraping at every stop, until a stop contributes no track
// we haven't already seen. Checking for "any overlap with the first
// batch" (like the discography scan does) doesn't work here: right
// after End, the rendered window can contain a partial mix of early
// and late rows at once, which overlaps with the first batch well
// before everything in between has actually been collected. "No new
// tracks at this stop" is the reliable signal instead (confirmed
// empirically: new tracks kept appearing for 10 PageUps after End
// before flattening out, on a playlist where the first overlap
// appeared immediately)
app.get("/playlist-more", async (req, res) => {

    res.setHeader("Content-Type", "application/x-ndjson");

    try {

        // "Charger plus" can be tapped moments after the initial batch
        // is shown - make sure the tracklist has actually finished
        // rendering that batch before treating it as the reference set
        await waitForStableCount(page.locator('[data-testid="tracklist-row"]'), { checks: 2, interval: 300, timeout: 3000 });

        const totalTracks = await getPlaylistTrackCount();

        // /playlist already pre-positions the scrollbar past this batch
        // before responding, so re-scraping "what's visible now" here
        // would skip it entirely - reuse the batch it already captured
        const collected = new Map();
        for (const track of lastPlaylistInitialTracks) collected.set(track.id, track);

        // whatever's visible now is already further ahead thanks to that
        // pre-positioning - scrape it too instead of discarding the head start
        const currentlyVisible = await scrapeVisibleTracklistRows();
        for (const track of currentlyVisible) collected.set(track.id, track);

        // a synthetic container.focus() is unreliable here - a real,
        // trusted click gives focus reliably instead. Clicking a track
        // row would risk starting its playback, so we click the column
        // header row ("# Titre Album Date d'ajout"), which is inert
        const headerHandle = await page.evaluateHandle(() => {

            function findScrollable(el) {
                while (el && el !== document.body) {
                    const style = getComputedStyle(el);
                    if ((style.overflowY === "auto" || style.overflowY === "scroll") && el.scrollHeight > el.clientHeight) {
                        return el;
                    }
                    el = el.parentElement;
                }
                return null;
            }

            const row = document.querySelector('[data-testid="tracklist-row"]');
            const container = row ? findScrollable(row) : null;

            return container ? container.querySelector('[role="row"]') : null;

        });

        const headerEl = headerHandle.asElement();
        const focused = !!headerEl;
        if (headerEl) await headerEl.click({ timeout: 3000 }).catch(() => {});
        await headerHandle.dispose();

        // walk forward from the top in small PageDown steps instead of
        // jumping to the bottom with End and working back up - the render
        // window only turns messy (mixing far-apart rows together) right
        // at the very top/bottom extremes, so incremental forward steps
        // stay clean almost the whole way, and tracks arrive close to
        // playback order already. Stop as soon as the known total (read
        // from the playlist header) is reached; scrollTop plateauing is
        // kept only as a bare safety net for the rare case where the
        // total couldn't be read
        if (focused && (!totalTracks || collected.size < totalTracks)) {

            const maxPageDowns = 40;
            let pageDowns = 0;
            let lastScrollTop = -1;

            while (pageDowns < maxPageDowns) {

                if (totalTracks && collected.size >= totalTracks) break;

                await page.keyboard.press("PageDown");
                await page.waitForTimeout(500);

                const rows = await scrapeVisibleTracklistRows();
                for (const row of rows) collected.set(row.id, row);

                const scrollInfo = await currentTracklistScrollInfo();
                if (scrollInfo && scrollInfo.scrollTop === lastScrollTop) break;
                if (scrollInfo) lastScrollTop = scrollInfo.scrollTop;

                pageDowns++;

            }

        }

        // tracks mostly arrive in playback order already with the forward
        // scan, but sort by the real position (aria-rowindex) anyway as a
        // free correctness net against the rare messy render window
        const orderedTracks = [...collected.values()].sort((a, b) => a.rowIndex - b.rowIndex);

        res.write(JSON.stringify({ tracks: orderedTracks, done: true }) + "\n");
        res.end();

        // leaves the cursor near the bottom (where the scan stopped) -
        // recenter it so the direction-based search fallback (see
        // getDirectionHint in player.js) still has room to move either
        // way if a tap misses a virtualized-out track. Purely prepares
        // future taps - the remote already has its answer, this
        // shouldn't delay it, and failures are just logged
        if (focused) {
            try {
                await scrollTracklistToFraction(0.5);
            } catch (e) {
                console.error("post-scan recenter failed:", e);
            }
        }

    } catch (e) {
        console.error(e);
        res.end();
    }

});

// the sidebar library list (playlists/artists/albums) is virtualized
// the same way tracklists are, so it gets the same coarse pagination
app.get("/library", async (req, res) => {

    const type = req.query.type;

    try {

        const selected = await selectLibraryChip(type);

        if (!selected) {
            return res.status(404).send("filter not found");
        }

        await page.waitForTimeout(600);

        await scrollLibraryToTop();
        await page.waitForTimeout(300);

        const tracks = await scrapeVisibleLibraryRows();
        const scrollInfo = await currentLibraryScrollInfo();

        res.json({
            tracks,
            atTop: true,
            atBottom: scrollInfo ? (scrollInfo.scrollTop + scrollInfo.clientHeight >= scrollInfo.scrollHeight - 2) : true
        });

    } catch (e) {
        console.error(e);
        res.status(500).send("library error");
    }

});

// same "load more" pattern as the discography grid: scrape the top,
// jump to the bottom with the real End key, and walk back up with
// PageUp until the rows seen overlap with the top batch - unlike
// playlists, nothing here plays back "in order", so the discography's
// simpler any-overlap stop applies directly, no exact-count needed
app.get("/library-more", async (req, res) => {

    const type = req.query.type;

    res.setHeader("Content-Type", "application/x-ndjson");

    try {

        const selected = await selectLibraryChip(type);

        if (!selected) {
            res.end();
            return;
        }

        await page.waitForTimeout(600);

        const rows = await scrapeAllLibraryRows();

        res.write(JSON.stringify({ tracks: rows, done: true }) + "\n");
        res.end();

        // leaves the cursor wherever the scan stopped (near the top, once
        // it overlapped with the first batch) - recenter it so the
        // direction-based search fallback (see getDirectionHint in
        // player.js) still has room to move either way if a tap misses a
        // virtualized-out row. Purely prepares future taps - the remote
        // already has its answer, this shouldn't delay it, and failures
        // are just logged
        try {
            await scrollLibraryToFraction(0.5);
        } catch (e) {
            console.error("post-scan library recenter failed:", e);
        }

    } catch (e) {
        console.error(e);
        res.end();
    }

});

// clicking a library folder navigates the sidebar into it (like a
// breadcrumb), rather than expanding it in place, so we scrape its
// contents then use the "Retour" button to back out
async function tryClickFolder(id) {

    return await page.evaluate((id) => {

        const lib = document.querySelector('[class*="YourLibraryX"]');

        if (!lib) return false;

        const rows = [...lib.querySelectorAll('[role="row"]')];

        const folderRow = rows.find(row => {
            const labelledBy = row.querySelector('[data-encore-id="listRow"]')?.getAttribute("aria-labelledby") || "";
            return labelledBy.endsWith("folder:" + id);
        });

        const clickTarget = folderRow?.querySelector('[role="button"]');

        if (!clickTarget) return false;

        clickTarget.click();
        return true;

    }, id);

}

app.get("/library-folder", async (req, res) => {

    const id = req.query.id;
    const direction = req.query.direction === "up" ? "up" : "down";

    if (!id) {
        return res.status(400).send("missing id");
    }

    try {

        let opened = await tryClickFolder(id);

        if (!opened) {
            opened = await scrollLibraryAndRetryClick(() => tryClickFolder(id), direction);
        }

        if (!opened) {
            return res.status(404).send("folder not found");
        }

        await page.waitForTimeout(800);
        await waitForStableCount(page.locator('[class*="YourLibraryX"] [role="row"]'));

        const tracks = await scrapeVisibleLibraryRows();

        // stay inside the folder rather than backing out of it - its
        // contents need to still be visible in the sidebar for
        // tryClickAnywhere/tryClickFolder to find them if the user
        // taps one of them next
        res.json(tracks);

    } catch (e) {
        console.error(e);
        res.status(500).send("library-folder error");
    }

});

// the sidebar keeps its own navigation state independent of whatever
// the main content pane is showing (confirmed: browsing into a
// playlist from inside a folder doesn't close the folder in the
// sidebar) - so going "back" to a library/folder view should use the
// sidebar's own real Retour button (to actually exit a folder) or, if
// the sidebar never left that state to begin with, just re-read it
app.get("/library-back", async (req, res) => {

    const exitFolder = req.query.exitFolder === "1";

    try {

        if (exitFolder) {
            const clicked = await page.evaluate(() => {
                const lib = document.querySelector('[class*="YourLibraryX"]');
                const back = [...(lib?.querySelectorAll("button") || [])].find(b => b.getAttribute("aria-label") === "Retour");
                if (!back) return false;
                back.click();
                return true;
            });
            if (clicked) {
                await page.waitForTimeout(500);
                await waitForStableCount(page.locator('[class*="YourLibraryX"] [role="row"]'));
            }
        }

        const tracks = await scrapeVisibleLibraryRows();
        res.json(tracks);

    } catch (e) {
        console.error(e);
        res.status(500).send("library-back error");
    }

});

app.get("/context-and-queue", async (req, res) => {

    try {

        const result = await getContextAndQueue();
        res.json(result);

    } catch (e) {
        console.error(e);
        res.status(500).send("context-and-queue error");
    }

});

app.get("/queue-play", async (req, res) => {

    const index = Number(req.query.index);
    const listType = req.query.list === "manual" ? "manual" : "queue";

    if (isNaN(index) || index < 0) {
        return res.status(400).send("invalid index");
    }

    try {

        // no longer guaranteed to already be open now that the panel
        // isn't kept open by a separate polling call - reopen it here
        // if needed, same as everywhere else that reads it
        let list = await page.$('ul[aria-label="À suivre"]');
        if (!list) {
            await page.getByTestId("control-button-queue").click();
            await page.waitForSelector('ul[aria-label="À suivre"]', { timeout: 8000 });
        }

        const selector = listType === "manual"
            ? 'ul[aria-label="À suivre dans la file d\'attente"]'
            : 'ul[aria-label="À suivre"]';

        const clicked = await page.evaluate(({ selector, index }) => {

            const list = document.querySelector(selector);
            if (!list) return false;

            const rows = [...list.querySelectorAll('li[role="row"]')];
            const row = rows[index];

            if (!row) return false;

            const btn = row.querySelector('[data-testid="play-button"]');

            if (!btn) return false;

            btn.click();
            return true;

        }, { selector, index });

        if (!clicked) {
            return res.status(404).send("not found");
        }

        res.send("ok");

    } catch (e) {
        console.error(e);
        res.status(500).send("queue-play error");
    }

});

app.get("/queue-remove", async (req, res) => {

    const index = Number(req.query.index);
    const listType = req.query.list === "manual" ? "manual" : "queue";

    if (isNaN(index) || index < 0) {
        return res.status(400).send("invalid index");
    }

    try {

        let list = await page.$('ul[aria-label="À suivre"]');
        if (!list) {
            await page.getByTestId("control-button-queue").click();
            await page.waitForSelector('ul[aria-label="À suivre"]', { timeout: 8000 });
        }

        const selector = listType === "manual"
            ? 'ul[aria-label="À suivre dans la file d\'attente"]'
            : 'ul[aria-label="À suivre"]';

        const countBefore = await page.evaluate((selector) => {
            const list = document.querySelector(selector);
            return list ? list.querySelectorAll('li[role="row"]').length : 0;
        }, selector);

        const opened = await page.evaluate(({ selector, index }) => {

            const list = document.querySelector(selector);
            if (!list) return false;

            const row = list.querySelectorAll('li[role="row"]')[index];
            if (!row) return false;

            const btn = row.querySelector('[data-testid="more-button"]');
            if (!btn) return false;

            btn.click();
            return true;

        }, { selector, index });

        if (!opened) {
            return res.status(404).send("not found");
        }

        await page.waitForSelector('[role="menu"]', { timeout: 3000 }).catch(() => {});

        const clicked = await page.evaluate(() => {

            const menu = document.querySelector('[role="menu"]');
            if (!menu) return false;

            const item = [...menu.querySelectorAll('[role="menuitem"]')].find(i =>
                i.innerText.trim() === "Supprimer de la file d'attente"
            );

            if (!item) return false;

            item.click();
            return true;

        });

        if (!clicked) {
            await page.keyboard.press("Escape").catch(() => {});
        } else {
            // the row's removal is animated on Spotify's side - a fixed
            // wait here was sometimes too short, leaving the client's
            // immediate refresh to catch a stale, not-yet-updated list.
            // Wait for the row count to actually drop instead
            await page.waitForFunction(
                ({ selector, countBefore }) => {
                    const list = document.querySelector(selector);
                    const count = list ? list.querySelectorAll('li[role="row"]').length : 0;
                    return count < countBefore;
                },
                { selector, countBefore },
                { timeout: 3000 }
            ).catch(() => {});
        }

        res.send(clicked ? "ok" : "not found");

    } catch (e) {
        console.error(e);
        res.status(500).send("queue-remove error");
    }

});

app.get("/seek", async (req, res) => {

    const percent = Number(req.query.percent);

    if (isNaN(percent) || percent < 0 || percent > 1) {
        return res.status(400).send("invalid percent");
    }

    await page.evaluate((percent) => {

        const input = document.querySelector(
            '[data-testid="playback-progressbar"] input[type="range"]'
        );

        if (!input) {
            throw new Error("Seek input introuvable");
        }

        const max = Number(input.max);

        input.value = Math.floor(max * percent);

        input.dispatchEvent(
            new Event("input", { bubbles: true })
        );

        input.dispatchEvent(
            new Event("change", { bubbles: true })
        );

    }, percent);

    res.send("ok");
});

app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server listening on port ${PORT}`);
    await connectSpotify();
});
