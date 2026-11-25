# Server-Setup für TankiTankiGeldiGeldi

## 1. Repo auf den Server

```bash
cd /var/www
git clone https://github.com/DEIN-USER/tankigeldi.git
cd tankigeldi
npm install
```

## 2. Datenbankordner anlegen

```bash
sudo mkdir -p /var/lib/tankigeldi
sudo chown www-data:www-data /var/lib/tankigeldi
```

## 3. Systemd-Dienst einrichten

```bash
sudo cp deploy/tankigeldi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable tankigeldi
sudo systemctl start tankigeldi
sudo systemctl status tankigeldi
```

## 4. Caddy-Konfiguration – neuen Block in /etc/caddy/Caddyfile einfügen

```
tankigeldi.lsh-portal.de {
    reverse_proxy localhost:8081 {
        header_up X-Forwarded-Proto {scheme}
    }
}
```

Dann Caddy neu laden:
```bash
sudo systemctl reload caddy
```

## 5. DNS – Subdomain anlegen

Im Strato-Kundencenter (oder wo auch immer die Domain verwaltet wird):
- Typ: A-Record
- Name: tankigeldi
- Wert: (selbe IP wie lsh-portal.de)

## 6. Automatische Updates

Prüft alle 5 Minuten GitHub, holt neue Versionen und startet Tanki neu:

```bash
install -m 755 deploy/update.sh /usr/local/bin/tankigeldi-update
install -m 644 deploy/tankigeldi-update.service deploy/tankigeldi-update.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now tankigeldi-update.timer
```

Letzte Updates ansehen: `journalctl -u tankigeldi-update -n 20`

## Logs prüfen

```bash
journalctl -u tankigeldi -f
```

## Caddy-Eintrag dauerhaft sichern

Das automatische Update des LSH-Portals schreibt `/etc/caddy/Caddyfile` neu. Damit der Tanki-Eintrag danach wieder drin ist:

```bash
install -m 755 deploy/tanki-caddy.sh /usr/local/bin/tanki-caddy
mkdir -p /etc/systemd/system/lsh-update.service.d
install -m 644 deploy/lsh-update-tanki.conf /etc/systemd/system/lsh-update.service.d/tanki.conf
systemctl daemon-reload
```
