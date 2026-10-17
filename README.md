# Camunda Verwaltung

Lokaler Node.js-Dienst für Basel, Brugg und Olten. Node.js 18 oder neuer; keine npm-Abhängigkeiten. Start: npm start. Adresse: http://127.0.0.1:3300

## Bereiche

- Live: lesende OAuth-/Console-Prüfung und Clusterliste; Operate-Prüfung nur bei vollständigen Runtime-Credentials.
- Cleanup: ausgegraut und inaktiv. Der Server sperrt sämtliche schreibenden HTTP-Methoden. Bestehende Verwaltungs- und Cleanup-Implementierungen bleiben im Code erhalten.
- Studenten hinzufügen: Semikolon-Liste prüfen, Duplikate entfernen und ungültige E-Mail-Adressen anzeigen. Einladungen sind noch nicht implementiert/freigeschaltet.

## Zugangsdaten

Der Server liest credentials_basel.txt, credentials_brugg.txt und credentials_olten.txt lokal. Secrets und Tokens werden nicht an den Browser ausgegeben. Zugangsdaten sind per .gitignore ausgeschlossen.

Live bestätigt Console-Zugriff getrennt vom Runtime-Zugriff. Fehlende Runtime-Zugangsdaten werden ausdrücklich angezeigt.

Die leeren Vorlagen credentials_basel.example, credentials_brugg.example und credentials_olten.example können lokal als entsprechende .txt-Dateien kopiert und mit den exportierten Camunda-Zugangsdaten befüllt werden. Echte Zugangsdaten bleiben ausschliesslich in den ignorierten .txt-Dateien.

## Weiterarbeit auf einem anderen Rechner

Siehe [HANDOFF.md](HANDOFF.md) für Einrichtung, geprüften Stand, Berechtigungen und offene Aufgaben.

