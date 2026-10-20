# Puffdrop

AirDrop for Ubuntu. Send and receive files with nearby iPhones, iPads and Macs from a GNOME Shell panel, in both Everyone and Contacts Only mode.

Puffdrop is a port of [Omdrop](https://github.com/netmojo-systems/omdrop-plugin) by Brent Kearney from Omarchy to Ubuntu and GNOME: the Omarchy bar panel is replaced by a GNOME Shell extension, and the command line and installer use Ubuntu's tools.

## Requirements

- Ubuntu with GNOME Shell 50 (Ubuntu 26.04).
- A Wi-Fi card the radio backend, [omdrop-owl](https://github.com/t4t5/omdrop-owl), can drive. Its [supported hardware](https://github.com/t4t5/omdrop-owl#supported-hardware) table lists them: Intel AX200, AX201, AX211, BE and 9560, several MediaTek and Realtek cards. On Intel cards Wi-Fi is off while you are visible, and comes back when Puffdrop turns off.

## Install

```bash
git clone https://github.com/cyborgcode/puffdrop.git ~/puffdrop
cd ~/puffdrop
bin/puffdrop setup            # the puffdrop command, the receiver service and the panel
puffdrop install-driver       # the radio backend and receiver packages, with apt (asks for your password)
```

`install-driver` builds omdrop-owl from a pinned commit into a `.deb`, installs it with apt, installs `python3-libarchive-c` and `keyutils`, and, when UFW is active, adds one firewall rule: TCP 8771 on `awdl0`, from IPv6 link-local addresses only.

Log out and back in once: GNOME Shell on Wayland loads a new extension only at login. Then switch Puffdrop on in the Extensions app if it is not on already. Its icon, the AirDrop mark, appears in the top bar.

Run `puffdrop doctor` to see anything still missing.

### Installing the panel from a zip

```bash
tools/pack-extension.sh       # builds dist/puffdrop@cyborgcode.github.io.shell-extension.zip
gnome-extensions install --force dist/puffdrop@cyborgcode.github.io.shell-extension.zip
```

Any extension manager that installs a local zip takes the same file. The panel drives the `puffdrop` command, so `bin/puffdrop setup` still has to have run once.

## Upgrade

```bash
cd ~/puffdrop && git pull
puffdrop install-driver       # rebuilds the radio backend only if the new version needs a newer one
```

Log out and back in for a new panel to load.

## Receive files

Click the icon to open the panel:

- **The Puffdrop toggle** in Quick Settings, beside the system's own, turns receiving on and off; its arrow opens the menu below. While Puffdrop is on, its icon shows in the top bar.
- **Stay visible for** sets how long you stay visible: one file, a set time, or until you turn it off. The choice is remembered.
- **Everyone / Contacts Only** chooses who may send. The people button opens the known-senders list.
- **They see you as** sets the name Apple devices show. It defaults to the hostname.
- **Save files to** opens a folder chooser. It defaults to `~/Downloads`.

Received files are saved, copied to the clipboard, and announced in a notification; clicking the notification opens the file. A shared link arrives as a `.url` or `.webloc` file and opens in your browser; only `http` and `https` links open.

## Send files

Expand **Send to peers**, or press `n` in the panel. If Puffdrop is off, this turns it on. A radar shows each nearby device as a dot, brighter and nearer the centre for a stronger signal; devices that answer with a name are listed above it. Click one, choose files, and the row shows progress, with an **×** to cancel.

## Command line

```bash
puffdrop on 15                      # visible to everyone for 15 minutes
puffdrop on -c 10m                  # Contacts Only, for 10 minutes
puffdrop on once                    # until one file arrives
puffdrop off
puffdrop status
puffdrop window 30m                 # the default window, and where the panel's slider rests
puffdrop name "Study Laptop"
puffdrop dir ~/Drops
puffdrop peers -n                   # nearby devices, with names
puffdrop send ~/photo.jpg iPhone
puffdrop send "Studio Mac" https://ubuntu.com/
puffdrop senders add you@icloud.com
puffdrop visibility contacts
```

Run `puffdrop help` for the rest. `puffdrop skill install` links a skill that tells AI agents how to use `puffdrop`.

## Your AirDrop identity

Apple devices recognize this computer by its AirDrop identity. Puffdrop creates a self-signed one, which receives from anyone (or only your known senders) and sends to devices set to Everyone. Sending to Contacts Only devices needs an Apple-issued identity; see [docs/identity-contract.md](docs/identity-contract.md) and the [upstream notes](https://github.com/netmojo-systems/omdrop-plugin#your-airdrop-identity), including keeping it in 1Password with `puffdrop identity 1password import`.

The identity lives in `~/.omdrop/keys`, and the settings the radio backend shares in `~/.config/omdrop`: those names are part of the backend's contract, so they keep Omdrop's name.

## Privileges

The radio helper, `/usr/lib/omdrop/omdrop-discoverable`, runs as root through `pkexec`; omdrop-owl installs a polkit action that covers only that path and needs no password from your own active session. The receiver runs as you, so received files are yours.

## Remove

```bash
puffdrop firewall remove
puffdrop links remove
puffdrop skill remove
gnome-extensions uninstall puffdrop@cyborgcode.github.io
rm ~/.local/bin/puffdrop ~/.config/systemd/user/airdrop-receiver.service
sudo apt remove omdrop-owl
rm -rf ~/.omdrop                    # this computer's AirDrop identity
```

## Development

```bash
sudo apt install python3-libarchive-c keyutils openssl
python3 -m unittest discover -s tests
```

## Credits

Puffdrop is based on [Omdrop](https://github.com/netmojo-systems/omdrop-plugin) by Brent Kearney. The radio backend is [omdrop-owl](https://github.com/t4t5/omdrop-owl). The icon is [AirDrop](https://thenounproject.com/) by Lars Meiertoberens, from Noun Project, used under CC BY 3.0.

## Trademark

"AirDrop" is a trademark of Apple Inc. Puffdrop is an independent project, not affiliated with or endorsed by Apple.

## License

MIT. See [LICENSE](LICENSE).
