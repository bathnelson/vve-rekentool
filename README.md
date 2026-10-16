# Rekenhulp subsidie verduurzaming Haarlemse VvE's

Stap-voor-stap formulier voor de rekentool van de Subsidieregeling verduurzaming Haarlemse VvE's 2026.
Eén statische pagina (`index.html`), gehost op GitHub Pages: https://bathnelson.github.io/vve-rekentool/

- Kies één adres van het gebouw: via de PDOK Locatieserver, de BAG en de VvE-clusterindex van de
  adresverkenner (`adresverkenner.nl/helpers/orvelis.php`) worden alle woningen van de VvE opgehaald,
  met energielabel (EP-Online) en WOZ-waarde op peildatum 1-1-2023.
- Aan het eind: de officiële rekentool (Excel) ingevuld, plus een overzicht om als PDF op te slaan.
- Ingevulde gegevens blijven in de browser van de gebruiker (localStorage); er wordt niets verstuurd.

Het Excel-template zit ingebed in `index.html` (base64), ontdaan van persoons- en SharePoint-metadata.
De adresverkenner kan de rekenhulp ook openen met de woningen al ingevuld via `#vve=<base64url-JSON>`.
