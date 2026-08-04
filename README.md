# Camunda Cleanup

Lokale, zunächst rein lesende Übersicht für die Camunda-Organisationen Basel, Brugg und Olten.

## Starten

Voraussetzung ist Node.js 18 oder neuer. Es werden keine Pakete installiert.

```powershell
npm start
```

Danach die Oberfläche unter <http://127.0.0.1:3300> öffnen.

## Zugangsdaten

Die Zugangsdaten verbleiben in den bestehenden lokalen Dateien:

- `credentials_basel - test.txt`
- `credentials_brugg.txt`
- `credentials_olten.txt`

Sie werden nur vom lokalen Server gelesen. Der Browser erhält weder Client Secret noch OAuth-Token. Die Dateien sind per `.gitignore` vom Commit ausgeschlossen.

## Aktueller Umfang

- Linke Navigation: Basel, Brugg, Olten
- Reiter: Member, Projekte, Connectors, Cluster
- Daten werden bei Bedarf direkt aus Camunda gelesen.
- Token werden im Speicher zwischengespeichert, um OAuth-Rate-Limits zu vermeiden.
- Es gibt absichtlich noch keine Schreib- oder Löschoperationen.

Für **Projekte** wird die Web-Modeler-API verwendet. Die verwendeten Credentials brauchen dafür die Leseberechtigung für Web Modeler. Die Reiter **Member** und **Cluster** verwenden die Administration-API. Der Reiter **Connectors** ist für die organisations-/clusterbezogene Connector-Verwaltung vorbereitet; ob diese Abfrage zulässig ist, hängt vom Scope `Connector Secrets` der Credentials ab.

## Nächster Schritt

Als nächstes können wir die vorhandenen Löschbeispiele in sichere Abläufe überführen: erst filterbare Vorschau, dann explizite Mehrfachauswahl und eine Bestätigung vor jedem endgültigen Löschen.
