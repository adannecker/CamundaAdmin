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

## Ereignisse und offene Zuweisungen

Das Ereignisprotokoll liegt dauerhaft in `data/operations.local.sqlite` (SQLite
mit WAL). Es enthält Auslöser, Zeitpunkt, Standort, Dozent, Klasse, Laufkennung,
Aktion und Ergebnis. Request-/Response-Bodies, API-Schlüssel, Tokens und
Excel-Zellen werden nicht protokolliert. Beim ersten Start werden vorhandene
Ausführungsbelege einmalig als Historie übernommen; deren Zeitpunkt ist der
Belegzeitpunkt. Ältere Einzelaktionen ohne Beleg sind nicht rekonstruierbar.
Externe Änderungen direkt in Camunda gehören nicht zu diesem Dienstprotokoll.

`Offene Zuweisungen` liest auf Knopfdruck Organisationseinladungen,
Workspace-Mitgliedschaften, Runtime-Gruppen und die vorgesehenen Gruppenrechte.
Es erfolgen dabei ausschließlich GETs und Such-POSTs. Der letzte Stand bleibt
in `data/assignment-status.local.json` erhalten; eine Änderung an der Klasse
verwirft dessen Gültigkeit. Zeitpunkt und unbekannte/fehlende Antworten bleiben
sichtbar. Die Funktion verschickt keine Einladungen und aktiviert keine
Automatik. `Meine Klassen` filtert nach dem angemeldeten Owner-Konto.

Lesend bestätigte Cleanup-Ergebnisse werden auch in die lokale Klassenablage
übernommen (einschließlich vorhandener Belege beim Start). Betroffene Automatik
wird deaktiviert; vollständig gelöschte Klassen heißen `cleaned` und werden in
der offenen Liste standardmäßig ausgeblendet. Sie lassen sich über „Bereinigte
Klassen anzeigen“ nachvollziehen. Ein neuer Excel-Import ersetzt eine vollständig
bereinigte Klasse durch einen frischen Entwurf ohne alte Einladungsbelege; der
vorherige Stand bleibt in `classes.local.json` unter `archivedClasses` erhalten.
Unbestätigte Löschversuche und Belege vor dem neuen Klassenlauf lösen diese
Umstellung nicht aus. Live-Abweichungen von einem früheren Einrichtungsabschluss
werden als Nachprüfung angezeigt und nicht automatisch repariert.

Für konsistente Backups die Anwendung stoppen und die gesamte `data/`-Ablage
einschließlich eventuell vorhandener SQLite-WAL-Dateien sichern. Die Datenbank
und die Statusdatei sind ebenso privat wie die Klassenlisten und nicht im Git.
