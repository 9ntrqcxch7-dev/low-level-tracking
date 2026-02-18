// Swedish Airport Database
const SWEDISH_AIRPORTS = {
    // Major International Airports
    'ESSA': { name: 'Stockholm Arlanda', lat: 59.6519, lon: 17.9186 },
    'ESGG': { name: 'Göteborg Landvetter', lat: 57.6628, lon: 12.2798 },
    'ESMS': { name: 'Malmö Sturup', lat: 55.5363, lon: 13.3762 },
    'ESSB': { name: 'Stockholm Bromma', lat: 59.3544, lon: 17.9417 },
    
    // Regional Airports
    'ESNU': { name: 'Umeå', lat: 63.7918, lon: 20.2828 },
    'ESNN': { name: 'Sundsvall-Timrå', lat: 62.5281, lon: 17.4439 },
    'ESNO': { name: 'Örnsköldsvik', lat: 63.4083, lon: 18.9900 },
    'ESNQ': { name: 'Kiruna', lat: 67.8220, lon: 20.3368 },
    'ESNS': { name: 'Luleå', lat: 65.5438, lon: 22.1220 },
    'ESNX': { name: 'Arvidsjaur', lat: 65.5903, lon: 19.2819 },
    'ESOE': { name: 'Örebro', lat: 59.2237, lon: 15.0380 },
    'ESOW': { name: 'Västerås', lat: 59.5894, lon: 16.6336 },
    'ESKN': { name: 'Skellefteå', lat: 64.6248, lon: 21.0769 },
    'ESUD': { name: 'Ronneby', lat: 56.2667, lon: 15.2650 },
    'ESOK': { name: 'Karlstad', lat: 59.4447, lon: 13.3374 },
    'ESMT': { name: 'Halmstad', lat: 56.6911, lon: 12.8202 },
    'ESMX': { name: 'Ängelholm-Helsingborg', lat: 56.2961, lon: 12.8471 },
    'ESMK': { name: 'Kristianstad', lat: 55.9217, lon: 14.0855 },
    'ESPA': { name: 'Luleå Kallax', lat: 65.5438, lon: 22.1220 },
    'ESDF': { name: 'Ronneby', lat: 56.2667, lon: 15.2650 },
    'ESNG': { name: 'Gällivare', lat: 67.1324, lon: 20.8146 },
    'ESNK': { name: 'Kramfors-Sollefteå', lat: 63.0486, lon: 17.7689 },
    'ESNL': { name: 'Lycksele', lat: 64.5483, lon: 18.7162 },
    'ESPE': { name: 'Pajala', lat: 67.2456, lon: 23.0689 },
    'ESNV': { name: 'Vilhelmina', lat: 64.5791, lon: 16.8336 },
    'ESNY': { name: 'Sveg', lat: 62.0478, lon: 14.4229 },
    'ESND': { name: 'Hudiksvall', lat: 61.7681, lon: 17.0808 },
    'ESNZ': { name: 'Östersund', lat: 63.1944, lon: 14.5003 },
    'ESSP': { name: 'Torsby', lat: 60.1576, lon: 12.9913 },
    'ESSV': { name: 'Visby', lat: 57.6628, lon: 18.3462 },
    'ESGT': { name: 'Trollhättan-Vänersborg', lat: 58.3181, lon: 12.3450 },
    'ESGP': { name: 'Göteborg City (Säve)', lat: 57.7747, lon: 11.8704 },
    'ESGJ': { name: 'Jönköping', lat: 57.7576, lon: 14.0687 },
    'ESGL': { name: 'Lidköping-Hovby', lat: 58.4655, lon: 13.1744 },
    'ESSL': { name: 'Linköping/Saab', lat: 58.4062, lon: 15.6805 },
    'ESSU': { name: 'Eskilstuna', lat: 59.3511, lon: 16.7084 },
    'ESKM': { name: 'Mora-Siljan', lat: 60.9579, lon: 14.5114 },
    'ESKS': { name: 'Borlänge-Dala', lat: 60.4220, lon: 15.5152 },
};

// Export for use in app.js
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SWEDISH_AIRPORTS;
}
