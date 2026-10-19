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

Die maßgebliche Ablage ist `data/camundaadmin.sqlite` (SQLite mit WAL).
Dozenten, Standortauswahl, Organisationen, Klassen, Gruppen, Studierende und
private Ressourcen besitzen strukturierte Tabellen. Vollständige Zustände,
Prüfstände und Ausführungsbelege werden zusätzlich als transaktionale Dokumente
aufbewahrt; deren frühere Dateinamen sind nur Datensatzschlüssel. Dokumente und
zugehörige Tabellen werden gemeinsam übernommen oder vollständig zurückgerollt.
Auch das Ereignisprotokoll liegt in derselben DB.

Die sechs `credentials_*.txt` bleiben getrennte private Secrets in `data/`.
`secrets/openai.env` ist zusätzlich schreibgeschützt als `/app/data/.env`
eingebunden. `secrets/auth.env` enthält den OIDC-Client-Secret und die feste
Owner-Freigabe. Verzeichnisse 0700, private Dateien 0600; kein Git für diese Daten.
Kurzlebige Sperrdateien koordinieren weiterhin die laufenden Aktionen.

Die erste Initialisierung übernimmt gültige `*.local.json`,
`admin-config.json`, `site-setup.json`, gegebenenfalls den Definitionenstatus
und die bisherige `operations.local.sqlite` in einer Transaktion. Originaltext
und Prüfsummen der Konfiguration bleiben erhalten. Spätere Starts verwenden
ausschließlich die DB; zurückkopierte JSON-Dateien überschreiben sie nicht.
Für eine neue Installation zunächst die Konfigurationsvorlagen und Secrets
bereitstellen oder eine konsistente DB-Sicherung wiederherstellen.
Die Dozentenkonfiguration lässt sich im Adminbereich als JSON exportieren.

Die automatischen Zugriffszuordnungen laufen nur in einer Instanz. Einen alten
lokalen Dienst vor der Übernahme stoppen. Für reine lokale Entwicklung ist
`AUTH_MODE=local` mit Loopback-Bindung möglich; bei Bedarf den Worker mit
`CLASS_ACCESS_WORKER=disabled` ausschalten. Ohne OIDC kann die Anwendung nicht
an eine öffentliche Adresse gebunden werden.

Bei bereits bestätigter Klasseneinrichtung arbeitet die Automatik in zwei
Phasen: Organisationsannahme und Editor-Zugriff auf den vorhandenen Gruppen-
Workspace werden über den Hub geprüft und ergänzt, auch wenn der Cluster
pausiert ist. Erst danach werden Runtime-Struktur und Tenant-Isolation geprüft
und die Runtime-Benutzerzuordnungen ergänzt. Bei vorübergehend nicht erreichbarer
Runtime bleibt die Klasse `pending` und die Automatik `waiting_runtime`; neue
Workspace-Zuordnungen und Runtime-Verfügbarkeit werden jede Minute geprüft.
Ein Neustart erhält Warteschlange und Anforderungsbelege. Unbestätigte
Workspace-Anfragen werden nicht erneut gesendet. Geänderte Freigaben,
privilegierte Konten und abweichende Runtime-Rechte stoppen weiterhin den Lauf.
Die erstmalige Anlage einer Klassenstruktur benötigt einen laufenden Cluster.

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

Das Ereignisprotokoll liegt dauerhaft in `data/camundaadmin.sqlite`.
Es enthält Auslöser, Zeitpunkt, Standort, Dozent, Klasse, Laufkennung,
Aktion und Ergebnis. Request-/Response-Bodies, API-Schlüssel, Tokens und
Excel-Zellen werden nicht protokolliert. Beim ersten Start werden vorhandene
Ausführungsbelege einmalig als Historie übernommen; deren Zeitpunkt ist der
Belegzeitpunkt. Ältere Einzelaktionen ohne Beleg sind nicht rekonstruierbar.
Externe Änderungen direkt in Camunda gehören nicht zu diesem Dienstprotokoll.

`Offene Zuweisungen` liest auf Knopfdruck Organisationseinladungen,
Workspace-Mitgliedschaften, Runtime-Gruppen und die vorgesehenen Gruppenrechte.
Es erfolgen dabei ausschließlich GETs und Such-POSTs. Der letzte Stand bleibt
in der Datenbank erhalten; eine Änderung an der Klasse
verwirft dessen Gültigkeit. Zeitpunkt und unbekannte/fehlende Antworten bleiben
sichtbar. Die Funktion verschickt keine Einladungen und aktiviert keine
Automatik. `Meine Klassen` filtert nach dem angemeldeten Owner-Konto.

Lesend bestätigte Cleanup-Ergebnisse werden auch in die lokale Klassenablage
übernommen (einschließlich vorhandener Belege beim Start). Betroffene Automatik
wird deaktiviert; vollständig gelöschte Klassen heißen `cleaned` und werden in
der offenen Liste standardmäßig ausgeblendet. Sie lassen sich über „Bereinigte
Klassen anzeigen“ nachvollziehen. Ein neuer Excel-Import ersetzt eine vollständig
bereinigte Klasse durch einen frischen Entwurf ohne alte Einladungsbelege; der
vorherige Stand bleibt als archivierter Klassenlauf in der Datenbank erhalten.
Unbestätigte Löschversuche und Belege vor dem neuen Klassenlauf lösen diese
Umstellung nicht aus. Live-Abweichungen von einem früheren Einrichtungsabschluss
werden als Nachprüfung angezeigt und nicht automatisch repariert.

Für konsistente Backups die Anwendung stoppen und die gesamte `data/`-Ablage
einschließlich eventuell vorhandener SQLite-WAL-Dateien sichern. Die Datenbank
ist ebenso privat wie die Klassenlisten und nicht im Git.

## Geprüfte Migration und Bereinigung

Vor dem Wechsel die alte Instanz stoppen und `data/`, `secrets/` und Compose
privat sichern. Das neue Image bauen und die Migration zunächst auf einer
isolierten Kopie testen. Danach offline im Daten-Volume ausführen:

```sh
docker compose run --rm -T app node migrate-data.js --root /app/data
docker compose run --rm -T app node migrate-data.js --root /app/data --prune --backup-confirmed
docker compose up -d
```

Die Prüfung vergleicht Quelldateien anhand ihrer Hashes, prüft Integrität und
Fremdschlüssel und vergleicht alle alten Ereigniszeilen mit der neuen DB.
Die Bereinigung entfernt ausschließlich nachweislich migrierte Dateien und
das alte Ereignis-DB-Dateiset im eigenen Datenordner. Veränderte oder nicht
migrierte Quelldateien stoppen sie. Secrets und Backups werden nicht entfernt.
Bei einer Rücknahme alten Code und den vollständigen vorherigen Datenstand
zusammen wiederherstellen; niemals zwei unabhängige Worker starten.
