// Swedish Airport Database (ASCII-normalized)
// Expose as a window global so client code can read it from `window.SWEDISH_AIRPORTS`.
window.SWEDISH_AIRPORTS = window.SWEDISH_AIRPORTS || {
    // Major International Airports
    'ESSA': { name: 'Stockholm Arlanda', lat: 59.6519, lon: 17.9186 },
    'ESGG': { name: 'Gothenburg Landvetter', lat: 57.6628, lon: 12.2798 },
    'ESMS': { name: 'Malmo Sturup', lat: 55.5363, lon: 13.3762 },
    'ESSB': { name: 'Stockholm Bromma', lat: 59.3544, lon: 17.9417 },

    // Regional Airports
    'ESNU': { name: 'Umea', lat: 63.7918, lon: 20.2828 },
    'ESNN': { name: 'Sundsvall-Timra', lat: 62.5281, lon: 17.4439 },
    'ESNO': { name: 'Oernskoeldsvik', lat: 63.4083, lon: 18.9900 },
    'ESNQ': { name: 'Kiruna', lat: 67.8220, lon: 20.3368 },
    'ESNX': { name: 'Arvidsjaur', lat: 65.5903, lon: 19.2819 },
    'ESOE': { name: 'Oerebro', lat: 59.2237, lon: 15.0380 },
    'ESOW': { name: 'Vasteras', lat: 59.5894, lon: 16.6336 },
    'ESKN': { name: 'Skelleftea', lat: 64.6248, lon: 21.0769 },
    'ESUD': { name: 'Ronneby', lat: 56.2667, lon: 15.2650 },
    'ESOK': { name: 'Karlstad', lat: 59.4447, lon: 13.3374 },
    'ESMT': { name: 'Halmstad', lat: 56.6911, lon: 12.8202 },
    'ESMX': { name: 'Angelholm-Helsingborg', lat: 56.2961, lon: 12.8471 },
    'ESMK': { name: 'Kristianstad', lat: 55.9217, lon: 14.0855 },
    'ESPA': { name: 'Lulea Kallax', lat: 65.5438, lon: 22.1220 },
    'ESNG': { name: 'Gallivare', lat: 67.1324, lon: 20.8146 },
    'ESNK': { name: 'Kramfors-Solleftea', lat: 63.0486, lon: 17.7689 },
    'ESNL': { name: 'Lycksele', lat: 64.5483, lon: 18.7162 },

    // Military Airbases
    'ESIB': { name: 'Satenas Air Base', lat: 58.426399, lon: 12.714400 },
    'ESDF': { name: 'Ronneby Airport', lat: 56.266701, lon: 15.265000 },
    'ESCM': { name: 'Arna Air Base (Uppsala)', lat: 59.897301, lon: 17.588600 },
    'ESCF': { name: 'Malmen Air Base', lat: 58.397666, lon: 15.522422 },
    'ESPE': { name: 'Vidsel Air Base', lat: 65.875298, lon: 20.149900 },

    'ESNV': { name: 'Vilhelmina', lat: 64.5791, lon: 16.8336 },
    'ESNY': { name: 'Sveg', lat: 62.0478, lon: 14.4229 },
    'ESND': { name: 'Hudiksvall', lat: 61.7681, lon: 17.0808 },
    'ESNZ': { name: 'Ostersund', lat: 63.1944, lon: 14.5003 },
    'ESSP': { name: 'Torsby', lat: 60.1576, lon: 12.9913 },
    'ESSV': { name: 'Visby', lat: 57.6628, lon: 18.3462 },
    'ESGT': { name: 'Trollhattan-Vanersborg', lat: 58.3181, lon: 12.3450 },
    'ESGP': { name: 'Gothenburg City (Save)', lat: 57.7747, lon: 11.8704 },
    'ESGJ': { name: 'Jonkoping', lat: 57.7576, lon: 14.0687 },
    'ESGL': { name: 'Lidkoping-Hovby', lat: 58.4655, lon: 13.1744 },
    'ESSL': { name: 'Linkoping/Saab', lat: 58.4062, lon: 15.6805 },
    'ESSU': { name: 'Eskilstuna', lat: 59.3511, lon: 16.7084 },
    'ESKM': { name: 'Mora-Siljan', lat: 60.9579, lon: 14.5114 },
    'ESKS': { name: 'Borlange-Dala', lat: 60.4220, lon: 15.5152 },
};

// Export for use in app.js / CommonJS environments
if (typeof module !== 'undefined' && module.exports) {
    // Export a safe object for CommonJS consumers (if any).
    // In browser we store the data on `window.SWEDISH_AIRPORTS`.
    if (typeof window !== 'undefined' && window.SWEDISH_AIRPORTS) {
        module.exports = window.SWEDISH_AIRPORTS;
    } else if (typeof global !== 'undefined' && global.SWEDISH_AIRPORTS) {
        module.exports = global.SWEDISH_AIRPORTS;
    } else {
        module.exports = {};
    }
}
