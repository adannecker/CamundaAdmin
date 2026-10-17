# Übergabe CamundaCleanup

Stand: 17. Oktober 2026. Diese Datei enthält keine Secrets. Externe Zustände und API-Funktionen bei Fortsetzung erneut prüfen.

## Auf einem anderen Rechner starten

1. Repository https://github.com/adannecker/CamundaCleanup klonen bzw. aktualisieren.
2. Node.js installieren (laut Projekt mindestens 18; eine unterstützte LTS-Version verwenden). Keine zusätzlichen npm-Pakete erforderlich.
3. credentials_basel.example, credentials_brugg.example und credentials_olten.example jeweils nach credentials_basel.txt, credentials_brugg.txt und credentials_olten.txt kopieren.
4. Aktuelle exportierte Administration-API-Zugangsdaten lokal eintragen. Die Beispieldateien sind absichtlich leer. Der Parser unterstützt export KEY="value" sowie einfache und doppelte Anführungszeichen.
5. Echte Credentials separat sicher übertragen oder neu erstellen. Sie sind nicht in Git und werden durch einen Clone nicht mitgenommen. Auch .env für Connector-Secrets ist lokal und ignoriert.
6. Im Projekt npm start ausführen (bei PowerShell-Ausführungsrichtlinien ggf. npm.cmd start). Oberfläche: http://127.0.0.1:3300/.
7. Live-Prüfung für alle Organisationen wiederholen. Zum Neustart nur den zu diesem Projekt gehörenden Node-Prozess beenden; danach npm start.

Die Datei credentials_basel - test.txt und access.txt werden vom aktuellen Dashboard nicht als Organisations-Credentials verwendet. Die alten Python-Skripte lesen access.txt; delete_developers.py löscht beim Ausführen ohne zusätzliche Rückfrage. Diese Skripte nicht als Verbindungstest starten.

## Implementiert

- server.js: Node-HTTP-Server, Camunda-API-Zugriffe, OAuth-Token-Cache und ältere Verwaltungs-/Cleanup-Implementierungen.
- public/index.html und public/dashboard.js: aktuelle Oberfläche mit Live, ausgegrautem Cleanup und Studenten hinzufügen.
- Live: OAuth und Console-Clusterabfrage; zusätzliche Operate-Abfrage nur bei vollständigen Runtime-Credentials.
- Studenten hinzufügen: Semikolon-/Zeilenliste prüfen, Duplikate erkennen, E-Mail-Format prüfen. Keine Einladungen oder Rollenzuweisungen implementiert.
- Alle schreibenden lokalen HTTP-Methoden sind zentral mit HTTP 403 gesperrt. RUNTIME_CLEANUP_ENABLED ist zusätzlich false.
- Ältere Member-/Projektlöschung, Clusteranlage/-löschung und Secret-Synchronisierung bleiben im Server erhalten, sind aber gesperrt. public/app.js ist die ältere, derzeit nicht eingebundene Oberfläche.

## Zuletzt geprüft

Am 17.10.2026 waren OAuth sowie lesende Member-, Projekt-, Connector-Secret-, Aktivitäts- und Clusterabfragen für alle drei Organisationen erfolgreich. Je Organisation ein Cluster GPMPM Workflows, jeweils Suspended. Fehlende Runtime-Credentials verhindern eine Runtime-Prüfung.

Basel wurde danach nochmals mit neuen Credentials geprüft: Token enthält zusätzlich CreateModel und UpdateModel. GET https://modeler.camunda.io/api/v1/info bestätigt createPermission, readPermission, updatePermission und deletePermission. Keine Schreiboperation wurde zum Nachweis ausgeführt.

Brugg und Olten wurden zunächst mit GetModel und DeleteModel angelegt. CreateModel und UpdateModel sind für diese beiden Organisationen noch nicht als ergänzt bestätigt. Vor Automatisierung prüfen/ergänzen und Credentials lokal aktualisieren.

Syntaxprüfungen für server.js und public/dashboard.js erfolgreich; Startseite, JS und CSS mit HTTP 200 geprüft. Schreibsperre für Member-, Projekt-, Cluster-, Secret- und Runtime-Cleanup-Endpunkte mit HTTP 403 geprüft. Es gibt keine automatisierte Testsuite. UI-Verhalten wurde noch nicht vollständig im Browser abgenommen.

## Vereinbarte Administration-API-Scopes

Credential-Namen: FHNW-Camunda-Admin-Basel, FHNW-Camunda-Admin-Brugg, FHNW-Camunda-Admin-Olten.

| Bereich | Zielauswahl |
| --- | --- |
| Cluster | Get, Create, Delete |
| Zeebe client | Get, Create |
| Web Modeler API | Get, Create, Update, Delete |
| Connector secrets | Get, Create, Update, Delete |
| Members | Get, Delete, Invite + Update Roles |
| Activity Logs | Download |

External Monitoring, IP AllowList, Backups, Cluster Update/Update encryption und Zeebe-client Delete wurden nicht ausgewählt. Connector secrets dient u. a. der Ablage von Google-/OpenAI-API-Keys für Connectoren. Die separate neue Hub-Credentials-Funktion ist nicht automatisch dasselbe wie Connector-Secrets.

## Offene Aufgaben in sinnvoller Reihenfolge

1. Brugg-/Olten-Scopes wie oben vervollständigen und alle Credentials auf dem neuen Rechner prüfen.
2. Hub-API-Migration untersuchen und umsetzen. Die aktuellen v1-Endpunkte und UI-Bezeichnungen stammen aus Web Modeler: frühere Projekte entsprechen in Hub 8.10 Workspaces, frühere Process Applications den neuen Projekten. Aktuelle Zähler dürfen deshalb nicht ungeprüft als neue Hub-Projektzahlen interpretiert werden.
3. Workspace-Verwaltung über dokumentierte Hub-v2-Endpunkte implementieren. Workspace-Mitglied hinzufügen/aktualisieren: POST /v2/workspaces/{workspaceKey}/members. Exakte Authentifizierung, Base-URL, Payload und Scopes anhand aktueller Dokumentation und lesender Tests verifizieren. Nicht von erteilten Scopes auf einen bereits getesteten Schreibablauf schliessen.
4. Studenten-Import fertigstellen: Organisation und Workspace wählen, Eingabeliste normalisieren, bestehende Mitglieder/Einladungen erkennen, Vorschau mit geplanter Organisationsrolle und Workspace-Rolle, explizite Bestätigung, dann gezielte Einladung/Zuweisung. Fehler je Adresse und Wiederholbarkeit berücksichtigen. Keine unnötigen doppelten Einladungen.
5. Runtime-Konzept prüfen: Cluster ist derzeit 8.9, Hub-Oberfläche 8.10. Pro Cluster prüfen, ob Authorizations aktiviert sind. Ohne aktivierte Prüfung gelten die vorgesehenen Einschränkungen nicht. Pausierte Cluster nur nach Nutzerauftrag aktivieren.
6. Separate Runtime-Credentials beschaffen und benötigte Rechte für Rollen-/Authorization-Verwaltung verifizieren. Zeebe-client Get/Create erlaubt Verwaltung von API-Clients, ersetzt keinen Runtime-Zugang. Bestehender processConnection-Parser erwartet CAMUNDA_CLIENT_ID oder ZEEBE_CLIENT_ID, entsprechendes Secret, CAMUNDA_CLUSTER_ID und Region; neue Exportformate/REST-Adressen ggf. ergänzen. Keine Runtime-Admin-Rechte voraussetzen, nur weil ein Token ausgestellt wird.
7. Studierenden-Rolle in Runtime vorbereiten, zunächst lesend prüfen und zur Freigabe vorlegen; tatsächliche Zuweisungen separat kontrolliert testen.
8. Cleanup bleibt bis zur ausdrücklichen Freigabe deaktiviert. Später einzelne freigegebene Endpunkte gezielt öffnen, nicht pauschal die globale Schreibsperre entfernen. Vorschau, Auswahl, Bestätigung, Fehlerprotokoll und erneute Prüfung des Ziels erhalten.
9. Live-Anzeige korrigieren: Clusterstatus ist ein Objekt mit ready/zeebeStatus/operateStatus usw. Dashboard rendert derzeit String(status) und kann [object Object] anzeigen. ready oder einzelne Komponenten lesbar darstellen. Fehlende Runtime-Credentials getrennt von fehlgeschlagener Authentifizierung zeigen.
10. Tokenabrufe ebenfalls mit Timeout versehen; derzeit haben die nachfolgenden Live-API-Aufrufe Timeouts, OAuth-Aufrufe jedoch nicht. Browser-Zeitüberschreitung beendet nicht automatisch den serverseitigen Abruf.
11. package.json-Beschreibung und Altcode-Dokumentation aktualisieren; sinnvolle Tests für Import, Berechtigungsgrenzen, Secret-Redaktion und Cleanup-Sperren ergänzen. UI mit schmaler Sidebar im Browser prüfen.

## Zielberechtigungen für Studierende

- Organisation: Member; nicht Org Admin oder DevOps. Developer ist für neue Zuweisungen veraltet.
- Workspace: Editor im jeweiligen Gruppen-Workspace; Unterrichts-Environment diesem Workspace zuordnen.
- Runtime: eigene Rolle, z. B. Studierende, getrennt von Hub-Rollen.
- Component ACCESS für tasklist und operate.
- RESOURCE CREATE zum Deployen; PROCESS_DEFINITION READ_PROCESS_DEFINITION, READ_PROCESS_INSTANCE, CREATE_PROCESS_INSTANCE.
- Aufgabenrechte je Unterrichtsmodell: READ_USER_TASK, CLAIM_USER_TASK, COMPLETE_USER_TASK, ggf. UPDATE_USER_TASK; tatsächliche Tasklist-Version und deren Berechtigungsmodell prüfen.
- Optional CANCEL_PROCESS_INSTANCE für laufende und DELETE_PROCESS_INSTANCE für beendete Instanzen. Operate-Batchaktionen können zusätzliche BATCH-Rechte benötigen; noch nicht geprüft.
- Rechte möglichst auf Prozess-IDs je Gruppe begrenzen. Workspace-Trennung isoliert keine Runtime-Instanzen. Eine Berechtigung für eine Prozessdefinition bedeutet nicht automatisch nur selbst gestartete Instanzen. Die gewünschte Begrenzung auf eigene Instanzen ist noch nicht gelöst/implementiert.

## Dokumentation zur Fortsetzung

- Rollen: https://docs.camunda.io/docs/components/hub/organization/users-and-roles/
- Hub-API-Migration: https://docs.camunda.io/docs/next/apis-tools/migration-manuals/migrate-from-web-modeler-to-hub-api/
- Runtime-Clients: https://docs.camunda.io/docs/components/saas/clusters/manage-api-clients/
- Berechtigungen passend zum Cluster 8.9: https://docs.camunda.io/docs/8.9/components/concepts/access-control/authorizations/
- Cluster-Einstellungen: https://docs.camunda.io/docs/components/saas/clusters/settings/

API-Dokumentation ist versionsabhängig. Die zuletzt dokumentierte neue Hub-v2-SaaS-Base-URL lautet https://hub.cloud.camunda.io/api/v2; vor Implementierung aktuell prüfen. Alte v1-Endpunkte sind laut Migrationsdokumentation ab 8.10 deprecated und sollen in 8.12 entfallen.

## Git und sichere Fortsetzung

Quellcode und leere Beispiele sind auf origin/main. Stand der Funktionsänderung: fffbe09. Diese Übergabe wird separat committed und gepusht. Kein Fetch/Pull oder automatisches Deployment ist Bestandteil des Dienstes.

Keine Secrets, exportierten Tokens, Mitgliederlisten oder Credential-Inhalte in Git, Logs oder Chat übernehmen. .gitignore schützt credentials_*.txt, access.txt, .env und definition-cleanup-state.json. Vor jedem Commit die konkret vorgemerkten Dateien prüfen.
