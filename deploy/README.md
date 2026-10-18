# Camunda Admin auf gpmpmwebserver

URL: https://gpmpm.iwi.hsw.fhnw.ch/camundaadmin/

Projekt: `/opt/fhnw/camundaadmin`, Git-Checkout: `src/`, Compose: `deploy/compose.yaml`.
Der öffentliche Traefik leitet ausschließlich `/camundaadmin` und Unterpfade an den
internen Dienst weiter. Es wird kein zusätzlicher Host-Port veröffentlicht.

## Zugriff

Keycloak-Realm `fhnw`, eigener vertraulicher Client `camundaadmin`, AAI-Anbieter
`switch-eduid`. Authorization Code mit PKCE S256, State, Nonce und Prüfung der
ID-Token-Signatur. Zugriff nur für die in `secrets/auth.env` hinterlegte Kombination
aus Issuer, festem Benutzer-Subject, bestätigter E-Mail und AAI-Anbieter.
Anfangs ausschließlich `achim.dannecker@fhnw.ch`; andere Konten werden abgewiesen.
Organisationsrollen in Camunda verleihen keinen Zugriff auf diesen Dienst.

Sitzungen sind serverseitig, maximal eine Stunde gültig und gehen bei einem
Container-Neustart verloren. Cookies: Secure, HttpOnly, SameSite=Lax und auf den
Anwendungspfad begrenzt. Schreibzugriffe brauchen passende Origin und CSRF-Token.
Abmelden beendet die Anwendungssitzung; die gemeinsame AAI-Sitzung anderer
Anwendungen bleibt bestehen. Spätere zusätzliche Admins und eine beschränkte
Dozentenansicht benötigen eine eigene Zugriffsregel; derzeit existiert keine
solche Freigabe.

## Daten und Secrets

`data/` enthält die sechs Camunda-Credential-Dateien, `admin-config.json`,
`site-setup.json`, `classes.local.json`, `lecturer-resources.local.json` sowie
gegebenenfalls `onboarding-<standort>.local.json`. Alle weiteren Laufzustände
werden ebenfalls dort gespeichert. `secrets/openai.env` ist die übertragene `.env`;
sie wird zusätzlich schreibgeschützt als `/app/data/.env` eingebunden.
`secrets/auth.env` enthält den OIDC-Client-Secret und die feste Owner-Freigabe.
Diese Dateien gehören niemals ins Git. Verzeichnisse 0700, private Dateien 0600.

Die automatischen Zugriffszuordnungen laufen nur in einer Instanz. Einen alten
lokalen Dienst vor der Übernahme stoppen. Für reine lokale Entwicklung ist
`AUTH_MODE=local` mit Loopback-Bindung möglich; bei Bedarf den Worker mit
`CLASS_ACCESS_WORKER=disabled` ausschalten. Ohne OIDC kann die Anwendung nicht
an eine öffentliche Adresse gebunden werden.

## Betrieb

```sh
cd /opt/fhnw/camundaadmin/deploy
docker compose ps
docker compose logs --tail=50 app
docker compose up -d --build
docker compose stop
```

Das Image nutzt Node 24 und Python 3, läuft ohne root, mit schreibgeschütztem
Root-Dateisystem und ohne zusätzliche Linux-Capabilities. Daten und Secrets
werden nicht ins Image kopiert. Der öffentliche Healthcheck liefert nur `ok`.
Alle anderen APIs und Dateien benötigen eine Anmeldung.

Vor Aktualisierungen einen konsistenten privaten Snapshot von `data/`,
`secrets/` und `deploy/compose.yaml` erstellen; laufende Änderungen zuvor beenden
und den Dienst stoppen. Sichere Backups enthalten Zugangsdaten und Personendaten.
Quellcode separat aktualisieren und Tests ausführen. Daten niemals durch einen
frischen Git-Checkout ersetzen. Die Proxy-Sicherung liegt in `deploy/` und darf
bei einer Rücknahme nur nach Prüfung zwischenzeitlicher Änderungen verwendet
werden. `configure-proxy.py` bewahrt den Inode der eingebundenen Proxydatei.

`configure-keycloak.py` verwendet temporär bereitgestellte Bootstrap-Zugangsdaten
nur zum Einrichten dieses Clients. Es prüft die AAI-Verknüpfung des Owners und
verweigert die Übernahme eines fremden Clients mit gleichem Namen. Die
Bootstrap-Datei muss nach dem Lauf entfernt werden. Keine Secrets in Logs ausgeben.
