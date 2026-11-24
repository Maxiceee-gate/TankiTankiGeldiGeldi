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

## 6. Auto-Update (optional, wie LSH)

Wenn du dasselbe GitHub-Pull-System wie LSH nutzen willst:

```bash
# In /etc/systemd/system/tankigeldi-update.timer
[Unit]
Description=TankiGeldi Update Timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min

[Install]
WantedBy=timers.target
```

```bash
# In /etc/systemd/system/tankigeldi-update.service  
[Unit]
Description=TankiGeldi Update

[Service]
Type=oneshot
User=www-data
WorkingDirectory=/var/www/tankigeldi
ExecStart=/bin/bash -c 'git pull && npm install --production && systemctl restart tankigeldi'
```

```bash
sudo systemctl enable --now tankigeldi-update.timer
```

## Logs prüfen

```bash
journalctl -u tankigeldi -f
```
