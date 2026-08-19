#!/usr/bin/env bash

# Automates as much of this project's PC-side setup as can be done
# safely on an unknown machine: system requirements, the PipeWire
# virtual audio sink, Tailscale, optionally EasyEffects and a dedicated
# openbox autostart session, then launching Chromium and the server
# itself. See README.md's Setup section for the manual walkthrough this
# mirrors - re-run this any time, every step checks whether it's
# already done before acting.
#
# Nothing here installs anything via sudo (or writes over an existing
# config file) without asking first - if a step can't be done safely
# without knowing more about your system, it prints instructions
# instead of guessing.

set -uo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

# ---------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------

step() { echo -e "\n== $1 ==\n"; }
note() { echo "   $1"; }

confirm() {
    read -r -p "$1 [o/N] " reply
    [[ "$reply" =~ ^[oOyY] ]]
}

# ---------------------------------------------------------------------
# 1. package manager detection - reused by every install step below
# ---------------------------------------------------------------------

PKG_MANAGER=""
if command -v apt-get >/dev/null 2>&1; then PKG_MANAGER="apt"
elif command -v dnf >/dev/null 2>&1; then PKG_MANAGER="dnf"
elif command -v pacman >/dev/null 2>&1; then PKG_MANAGER="pacman"
elif command -v zypper >/dev/null 2>&1; then PKG_MANAGER="zypper"
fi

# installs $2 (a package name) via the detected manager, after printing
# the exact command and asking for confirmation - never runs anything
# via sudo silently. $1 is a human label used in the prompt.
install_pkg() {
    local label="$1" pkg="$2" cmd=""
    case "$PKG_MANAGER" in
        apt)    cmd="sudo apt-get install -y $pkg" ;;
        dnf)    cmd="sudo dnf install -y $pkg" ;;
        pacman) cmd="sudo pacman -S --noconfirm $pkg" ;;
        zypper) cmd="sudo zypper install -y $pkg" ;;
        *)
            note "Gestionnaire de paquets non reconnu - installez $label manuellement."
            return 1
            ;;
    esac
    note "$cmd"
    if confirm "Installer $label maintenant ?"; then
        eval "$cmd"
    else
        note "Ignoré - installez $label manuellement avant de continuer."
        return 1
    fi
}

# ---------------------------------------------------------------------
# 2. system requirements
# ---------------------------------------------------------------------

step "Vérification des prérequis système"

if command -v gdbus >/dev/null 2>&1; then
    note "gdbus: déjà présent"
else
    note "gdbus est introuvable - il fait normalement partie de glib2/dbus, déjà installé sur"
    note "toute session de bureau Linux classique. Vérifiez votre installation D-Bus."
fi

if command -v ffmpeg >/dev/null 2>&1; then
    note "ffmpeg: déjà présent"
else
    install_pkg "ffmpeg" "ffmpeg"
fi

NODE_OK=0
if command -v node >/dev/null 2>&1; then
    NODE_MAJOR="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
    if [ "$NODE_MAJOR" -ge 18 ] 2>/dev/null; then
        note "Node.js: déjà présent ($(node --version), >= 18 requis)"
        NODE_OK=1
    else
        note "Node.js $(node --version) trouvé, mais ce projet a besoin de 18+."
    fi
else
    note "Node.js introuvable."
fi
if [ "$NODE_OK" -eq 0 ]; then
    note "Les paquets Node.js des dépôts système sont souvent trop anciens ou absents -"
    note "installez une version récente depuis https://nodejs.org/ (ou via nvm) avant de continuer."
fi

CHROMIUM_OK=0
if command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 \
    || command -v google-chrome >/dev/null 2>&1; then
    note "Chromium/Chrome: déjà présent"
    CHROMIUM_OK=1
else
    note "Chromium introuvable."
    install_pkg "Chromium" "chromium" && CHROMIUM_OK=1
    if [ "$CHROMIUM_OK" -eq 0 ]; then
        note "Si votre distribution nomme le paquet différemment (ex: chromium-browser sur"
        note "Debian/Ubuntu plus anciens), installez-le manuellement."
    fi
fi

if command -v tailscale >/dev/null 2>&1; then
    note "Tailscale: déjà présent"
else
    note "Tailscale introuvable. Son installeur officiel fonctionne sur la quasi-totalité des"
    note "distributions Linux, plus fiable que les paquets système pour ça :"
    note "curl -fsSL https://tailscale.com/install.sh | sh"
    if confirm "Lancer cette commande maintenant ?"; then
        curl -fsSL https://tailscale.com/install.sh | sh
    else
        note "Ignoré - installez Tailscale manuellement avant de continuer (section Tailscale plus bas)."
    fi
fi

if [ "$NODE_OK" -eq 0 ] || [ "$CHROMIUM_OK" -eq 0 ]; then
    echo
    if ! confirm "Node.js et/ou Chromium manquent encore - continuer quand même ?"; then
        echo "Installez les prérequis manquants puis relancez ce script."
        exit 1
    fi
fi

# ---------------------------------------------------------------------
# 3. npm install
# ---------------------------------------------------------------------

step "Dépendances du projet (npm install)"

if [ -d node_modules ] && [ "${1:-}" != "--force-npm-install" ]; then
    note "node_modules existe déjà - ignoré (relancez avec --force-npm-install pour forcer)."
else
    # This project only ever connects to an already-running, externally
    # launched Chromium over CDP - it never calls playwright.launch()
    # itself, so Playwright's own bundled browser download (several
    # hundred MB) is pure waste here.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install
fi

# ---------------------------------------------------------------------
# 4. PipeWire virtual sink
# ---------------------------------------------------------------------

step "Sink audio virtuel (spotify-remote-audio)"

until pactl info >/dev/null 2>&1; do
    note "En attente de PipeWire..."
    sleep 0.5
done

if pactl list short sinks | grep -q "spotify-remote-audio"; then
    note "Déjà créé."
else
    pactl load-module module-null-sink \
        sink_name=spotify-remote-audio \
        sink_properties=device.description=SpotifyRemoteAudio
    # Give PipeWire/WirePlumber a moment to finish initializing - same
    # fixed wait as openbox-autostart.example, no simple external signal
    # to poll for this one instead.
    sleep 3
    pactl set-default-sink spotify-remote-audio
    pactl set-sink-volume spotify-remote-audio 100%
    note "Créé et défini comme sortie par défaut."
fi

# ---------------------------------------------------------------------
# 5. Tailscale
# ---------------------------------------------------------------------

TAILSCALE_ADDR=""
if command -v tailscale >/dev/null 2>&1; then
    step "Tailscale"
    if tailscale status >/dev/null 2>&1; then
        note "Déjà connecté."
    else
        note "Ouverture de l'authentification Tailscale dans votre navigateur..."
        note "(Sans Tailscale, l'app ne pourra pas atteindre ce serveur depuis votre téléphone"
        note "en dehors de votre réseau local.)"
        if confirm "Lancer 'tailscale up' maintenant ?"; then
            sudo tailscale up
        fi
    fi
    if tailscale status >/dev/null 2>&1; then
        TAILSCALE_ADDR="$(tailscale ip -4 2>/dev/null | head -n1)"
        note "Adresse Tailscale : $TAILSCALE_ADDR"
        note "C'est ce qu'il faudra entrer dans les Paramètres de l'app Android."
    fi
fi

# ---------------------------------------------------------------------
# 6. EasyEffects (optional)
# ---------------------------------------------------------------------

EASYEFFECTS_INSTALLED=0

step "EasyEffects"
if confirm "Voulez-vous installer EasyEffects ? Indispensable pour adapter le niveau de gain des titres, à moins que vous ne vouliez le faire avec un de vos logiciels"; then

    if command -v flatpak >/dev/null 2>&1; then
        note "flatpak: déjà présent"
    else
        install_pkg "flatpak" "flatpak"
    fi

    if command -v flatpak >/dev/null 2>&1; then
        if flatpak list 2>/dev/null | grep -q com.github.wwmm.easyeffects; then
            note "EasyEffects: déjà installé."
            EASYEFFECTS_INSTALLED=1
        else
            note "flatpak install flathub com.github.wwmm.easyeffects"
            if confirm "Installer EasyEffects maintenant ?"; then
                flatpak install -y flathub com.github.wwmm.easyeffects && EASYEFFECTS_INSTALLED=1
            fi
        fi
    else
        note "flatpak indisponible - installez EasyEffects manuellement si vous en avez besoin."
    fi

    if [ "$EASYEFFECTS_INSTALLED" -eq 1 ]; then
        note "Lancement d'EasyEffects..."
        flatpak run com.github.wwmm.easyeffects >/dev/null 2>&1 &
        until pactl list short sinks 2>/dev/null | grep -q easyeffects; do
            sleep 0.5
        done
        echo
        note "EasyEffects est lancé. Réglages à faire une seule fois, dans sa fenêtre :"
        note "  1. Onglet Output (sortie)"
        note "  2. Ajoutez l'effet \"Auto Gain\""
        note "  3. Reference : Integrated"
        note "  4. Max History : 40s"
        note "  5. Target : -20dB"
        note "  6. Silence Threshold : -70dB"
        note "(Ces réglages sont sauvegardés automatiquement - à faire une seule fois.)"
        read -r -p "Appuyez sur Entrée une fois ces réglages faits pour continuer... "
    fi
else
    note "Ignoré."
fi

# ---------------------------------------------------------------------
# 7. dedicated openbox session (optional)
# ---------------------------------------------------------------------

step "Session dédiée (optionnel)"
note "Ce projet recommande une session de bureau minimale dédiée (voir README.md) plutôt que"
note "de faire tourner Chromium dans votre session principale."

if confirm "Configurer automatiquement le démarrage automatique openbox pour cette session dédiée ?"; then

    # GDM's autologin silently re-logs into whichever session was last
    # picked at the greeter (tracked per-user by AccountsService) - so
    # selecting the dedicated session there even once makes it the
    # autologin target from then on. Pinning the CURRENT session (the
    # one this script is running under - presumably the main one)
    # protects against that before it can happen, rather than relying
    # on the user to never accidentally click the wrong session icon.
    DISPLAY_MANAGER="$(basename "$(readlink -f /etc/systemd/system/display-manager.service 2>/dev/null)" 2>/dev/null)"
    if [ "$DISPLAY_MANAGER" = "gdm.service" ] || [ "$DISPLAY_MANAGER" = "gdm3.service" ]; then

        AUTOLOGIN_ON=0
        for GDM_CONF in /etc/gdm/custom.conf /etc/gdm3/custom.conf; do
            if [ -f "$GDM_CONF" ] && grep -qi '^AutomaticLoginEnable[[:space:]]*=[[:space:]]*true' "$GDM_CONF"; then
                AUTOLOGIN_ON=1
            fi
        done

        if [ "$AUTOLOGIN_ON" -eq 0 ]; then
            echo
            note "GDM détecté, mais sans connexion automatique - le risque documenté dans le"
            note "README (la session dédiée devenant la cible de connexion automatique après y"
            note "avoir cliqué une seule fois) ne s'applique pas ici."
            echo
            note "Un autre piège existe quand même : GDM présélectionne par défaut la dernière"
            note "session utilisée à l'écran de connexion, même sans connexion automatique. Si"
            note "vous éteignez juste après vous être déconnecté de la session dédiée, le"
            note "prochain démarrage à froid risque de la présélectionner directement - et une"
            note "session minimale comme celle-ci démarre plus difficilement juste après un"
            note "démarrage à froid que votre session habituelle. Reconnectez-vous d'abord sur"
            note "votre session normale après tout redémarrage, puis basculez manuellement sur"
            note "la session dédiée une fois le système bien réveillé."
        fi

        if [ "$AUTOLOGIN_ON" -eq 1 ]; then

            CUR_SESSION="${GDMSESSION:-${XDG_SESSION_DESKTOP:-${XDG_CURRENT_DESKTOP:-}}}"
            CUR_SESSION_TYPE="${XDG_SESSION_TYPE:-}"

            echo
            note "GDM avec connexion automatique est actif sur cette machine - risque connu"
            note "(voir README.md) : sélectionner la session dédiée une seule fois à l'écran de"
            note "connexion GDM en ferait la nouvelle session de connexion automatique."
            if [ -n "$CUR_SESSION" ]; then
                note "Session détectée pour CETTE fenêtre de terminal : $CUR_SESSION${CUR_SESSION_TYPE:+ ($CUR_SESSION_TYPE)}"
                note "IMPORTANT : si vous exécutez ce script depuis la session dédiée elle-même"
                note "(plutôt que votre session de bureau habituelle), épingler cette session ferait"
                note "exactement l'inverse de ce qui est voulu - à confirmer avant de continuer."
                if confirm "\"$CUR_SESSION\" est bien votre session de bureau HABITUELLE (pas la session dédiée) - épingler celle-ci maintenant (nécessite sudo) ?"; then

                    ACCOUNTS_FILE="/var/lib/AccountsService/users/$USER"

                    if sudo test -f "$ACCOUNTS_FILE"; then
                        BACKUP="/tmp/accountsservice-$USER.bak.$(date +%Y%m%d%H%M%S)"
                        sudo cp "$ACCOUNTS_FILE" "$BACKUP"
                        note "Fichier existant sauvegardé dans $BACKUP"
                    fi

                    {
                        echo "[User]"
                        echo "Session=$CUR_SESSION"
                        [ -n "$CUR_SESSION_TYPE" ] && echo "SessionType=$CUR_SESSION_TYPE"
                        if sudo test -f "$ACCOUNTS_FILE"; then
                            sudo grep -v -E '^\[User\]$|^Session=|^SessionType=' "$ACCOUNTS_FILE"
                        fi
                    } | sudo tee "$ACCOUNTS_FILE.new" >/dev/null
                    sudo mv "$ACCOUNTS_FILE.new" "$ACCOUNTS_FILE"
                    sudo chmod 644 "$ACCOUNTS_FILE"

                    note "Épinglé. La connexion automatique GDM restera sur \"$CUR_SESSION\" quoi que"
                    note "vous sélectionniez d'autre à l'écran de connexion."
                fi
            else
                note "Impossible de détecter automatiquement votre session actuelle - épinglez-la"
                note "manuellement (voir la section Setup du README.md pour les détails exacts)."
            fi

        fi

    else
        echo
        note "Display manager détecté : ${DISPLAY_MANAGER:-inconnu} (pas GDM) - la connexion"
        note "automatique éventuelle de ce display manager n'est pas gérée automatiquement ici,"
        note "voir la section Setup du README.md si votre distribution a un pitfall similaire."
    fi

    if ! command -v openbox >/dev/null 2>&1; then
        note "openbox est introuvable."
        install_pkg "openbox" "openbox"
    fi

    if command -v openbox >/dev/null 2>&1; then

        AUTOSTART="$HOME/.config/openbox/autostart"
        mkdir -p "$(dirname "$AUTOSTART")"

        if [ -f "$AUTOSTART" ]; then
            BACKUP="$AUTOSTART.bak.$(date +%Y%m%d%H%M%S)"
            cp "$AUTOSTART" "$BACKUP"
            note "Fichier autostart existant sauvegardé dans $BACKUP"
        fi

        cat > "$AUTOSTART" <<EOF
# Généré par setup.sh le $(date) - voir openbox-autostart.example dans le repo

until pactl info >/dev/null 2>&1; do sleep 0.2; done

if ! pactl list short sinks | grep -q "spotify-remote-audio"; then
    pactl load-module module-null-sink \\
        sink_name=spotify-remote-audio \\
        sink_properties=device.description=SpotifyRemoteAudio
fi
sleep 3
pactl set-default-sink spotify-remote-audio
pactl set-sink-volume spotify-remote-audio 100%

EOF

        if [ "$EASYEFFECTS_INSTALLED" -eq 1 ]; then
            cat >> "$AUTOSTART" <<'EOF'
flatpak run com.github.wwmm.easyeffects &
until pactl list short sinks | grep -q easyeffects; do sleep 0.2; done

EOF
        fi

        cat >> "$AUTOSTART" <<EOF
chromium --user-data-dir="\$HOME/.config/chromium-spotify" \\
  --remote-debugging-port=9222 \\
  --start-maximized &

until curl -s http://127.0.0.1:9222/json/version >/dev/null 2>&1; do sleep 0.2; done

(cd "$REPO_DIR" && node server.js >> "$REPO_DIR/server.log" 2>&1) &
EOF

        note "Écrit dans $AUTOSTART"
        if [ "$DISPLAY_MANAGER" != "gdm.service" ] && [ "$DISPLAY_MANAGER" != "gdm3.service" ]; then
            echo
            note "N'oubliez pas (voir README.md) : configurez votre display manager pour ne pas"
            note "démarrer automatiquement dans cette session dédiée."
        fi

    else
        note "Ignoré - openbox non installé."
    fi

else
    note "Ignoré. Pour ajouter ceci manuellement plus tard à votre propre environnement de"
    note "bureau, voir openbox-autostart.example dans le repo."
fi

# ---------------------------------------------------------------------
# 8. launch Chromium and wait for it to be ready
# ---------------------------------------------------------------------

step "Lancement de Chromium"

if curl -s http://127.0.0.1:9222/json/version >/dev/null 2>&1; then
    note "Un Chromium avec le débogage distant est déjà actif sur le port 9222."
else
    CHROMIUM_BIN="$(command -v chromium || command -v chromium-browser || command -v google-chrome)"
    if [ -z "$CHROMIUM_BIN" ]; then
        note "Aucun binaire Chromium/Chrome trouvé - lancez-le manuellement (voir README.md)"
        note "puis relancez ce script."
    else
        "$CHROMIUM_BIN" \
            --user-data-dir="$HOME/.config/chromium-spotify" \
            --remote-debugging-port=9222 \
            --app=https://open.spotify.com \
            --start-maximized &
        note "En attente que Chromium démarre..."
        until curl -s http://127.0.0.1:9222/json/version >/dev/null 2>&1; do
            sleep 0.2
        done
        note "Chromium est prêt."
    fi
fi

echo
note "Deux choses à faire manuellement dans la fenêtre Chromium qui vient de s'ouvrir :"
note "  1. Connectez-vous à Spotify si ce n'est pas déjà fait."
note "  2. Installez un bloqueur de pub (ex: uBlock Origin) si ce n'est pas déjà fait."
read -r -p "Appuyez sur Entrée une fois ces deux étapes faites pour continuer... "

# ---------------------------------------------------------------------
# 9. finish
# ---------------------------------------------------------------------

step "Terminé"

note "Pour démarrer le serveur : node server.js"
if [ -n "$TAILSCALE_ADDR" ]; then
    note "Adresse à entrer dans les Paramètres de l'app Android : http://$TAILSCALE_ADDR:3000"
else
    note "Configurez Tailscale (ou utilisez l'IP locale de cette machine) pour vous connecter"
    note "depuis l'app Android - voir README.md."
fi
echo

if confirm "Démarrer le serveur maintenant (node server.js) ?"; then
    node server.js
fi
