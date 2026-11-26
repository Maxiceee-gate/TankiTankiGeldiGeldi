# Design-Richtung: Verkehrszeichen

**Gegenstand & Publikum:** Eine Handvoll Freunde, die sich Fahrten und Spritkosten teilen – die App wird im Auto, am Straßenrand und an der Zapfsäule benutzt, oft bei Sonne.

**Richtung:** utilitär, nach deutscher Straßenbeschilderung. Klare Flächen, wenig Deko, alles auf einen Blick lesbar.

**Farbe** (RAL-Verkehrsfarben als Quelle, nicht das Framework):
- Fläche: kühles Hellgrau `--bg` (tags) / Asphalt-Blaugrau (nachts, `prefers-color-scheme: dark`)
- Text: Tinte, leicht ins Verkehrsblau getönt
- Akzent: **Verkehrsblau RAL 5017** – nur Hauptaktion, aktiver Tab, wichtigste Zahl
- Live/Achtung: **Verkehrsgelb RAL 1023** – nur „Fahrt läuft“ und Logo
- Signale: Verkehrsgrün RAL 6024 (bekommst/bezahlt), Verkehrsrot RAL 3020 (schuldest/Fehler)

**Schrift:** Barlow (DIN-1451-artige Grotesk der Straßenschilder) für alles; Barlow Condensed nur für Zahlen und Preise. Satzschreibung, keine Großbuchstaben-Labels. Skala 12/14/16/18/20/24/30/36.

**Layout:** Karte im Vollbild, Inhalte in einem ziehbaren Panel; linksbündig; Gruppen über Abstand und Überschrift statt Karten in Karten.

**Radius:** 4 (Inputs, Tags) · 8 (Buttons, Kacheln) · 14 (Panels/Sheets). Kreise nur für Personen und runde Kartenknöpfe.

**Mutiges Element:** Logo und „Fahrt läuft“-Karte als Ortsschild – gelbe Fläche, schwarzer Innenrand, Schildschrift.

**Bewegung:** nur als Feedback (Panel ziehen, Sheet öffnen), 150–250 ms ease-out; `prefers-reduced-motion` wird respektiert.
