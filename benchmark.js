const csv = require('csv-parser');
const fs = require('fs');
const nodeplotlib = require('nodeplotlib');
const results = [];
const mathjs = require('mathjs');
var bs = require('black-scholes');

let months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dateStringToDate(string) {
    let dd_mmm_yyyy = string.split(' ');

    return { d: +dd_mmm_yyyy[0], m: months.indexOf(dd_mmm_yyyy[1]) + 1, y: +dd_mmm_yyyy[2] };
}

let round = (num) => Math.round((num + Number.EPSILON) * 100) / 100;
wait = (ms) => new Promise((r) => setTimeout(r, ms));

let ITERATIONS = 1000;
let AMOUNT_LOCAL = 100000;

async function main() {
    let from = 2009;
    let to = 2019;
    let rawData = JSON.parse(fs.readFileSync('./USD-EUR-1999-2020.json'));
    let interestRatesDomestic = JSON.parse(fs.readFileSync('./FED-interest-rates.json'));
    let interestRatesForeign = JSON.parse(fs.readFileSync('./ECB-interest-rates.json'));

    let keys = Object.keys(rawData[0]);

    let local = keys[1];
    let foreign = keys[2];

    let data = rawData.map((r) => {
        return { date: dateStringToDate(r.Date), native: +r[local], foreign: +r[foreign] };
        // return { date: dateStringToDate(r.Date), native: +r[local], foreign: 1 / +r[foreign] };
    });

    let parsedInterestRates = {};
    for (let i of interestRatesDomestic) {
        parsedInterestRates[i.Year] = +i.Interest * 0.01;
    }
    interestRatesDomestic = parsedInterestRates;

    parsedInterestRates = {};
    for (let i of interestRatesForeign) {
        parsedInterestRates[i.Year] = +i.Interest * 0.01;
    }
    interestRatesForeign = parsedInterestRates;

    data = data.reverse();
    let volatilities = calculateVolatility(data.filter((r) => r.date.y >= from - 1 && r.date.y <= to - 1));
    data = data.filter((r) => r.date.y >= from && r.date.y <= to);

    // console.log('Chance_of_late_payment,benchmark,forward,option');
    console.log('Chance_of_late_payment,forward,option');
    for (let chanceOfLatePayment = 0; chanceOfLatePayment <= 1; chanceOfLatePayment += 0.01) {
        chanceOfLatePayment = round(chanceOfLatePayment);
        let winningsPercentVanilla = [];
        let winningsPercentForward = [];
        let winningsPercentOption = [];

        for (let i = 0; i < ITERATIONS; i++) {
            let iterationWinnings = calculateWinningsVanilla(data, chanceOfLatePayment);
            let entries = iterationWinnings.length;
            iterationWinnings = iterationWinnings.reduce((a, b) => a + b) / entries;

            winningsPercentVanilla.push(iterationWinnings);

            iterationWinnings = calculateWinningsForward(data, interestRatesDomestic, interestRatesForeign, chanceOfLatePayment);
            entries = iterationWinnings.length;
            iterationWinnings = iterationWinnings.reduce((a, b) => a + b) / entries;

            winningsPercentForward.push(iterationWinnings);

            iterationWinnings = calculateWinningsOption(data, interestRatesDomestic, interestRatesForeign, volatilities, chanceOfLatePayment);
            entries = iterationWinnings.length;
            iterationWinnings = iterationWinnings.reduce((a, b) => a + b) / entries;

            winningsPercentOption.push(iterationWinnings);
        }

        let avgVanilla = round(winningsPercentVanilla.reduce((a, b) => a + b) / ITERATIONS);
        let avgForward = round(winningsPercentForward.reduce((a, b) => a + b) / ITERATIONS);
        let avgOption = round(winningsPercentOption.reduce((a, b) => a + b) / ITERATIONS);
        // console.log(`${chanceOfLatePayment},${avgVanilla},${avgForward},${avgOption}`);
        console.log(`${chanceOfLatePayment},${avgForward},${avgOption}`);
    }

    // let indices = new Array(data.length).fill(0).map((_, i) => 1999 + i / 365);

    // const d = [{ x: data.map((d, i) => `#${i}_${d.date.d}-${d.date.m}-${d.date.y}`), y: data.map((d) => d.foreign), type: 'line' }];
    // nodeplotlib.plot(d);
}

main();

function calculateWinningsVanilla(data, chanceOfLatePayment) {
    let currentForeign = 0;
    let currentLocal = 0;

    let daysToDelayedPayment = 0;
    let missedPayment = 0;

    let winningsPercent = [];

    for (let i = 0; i < data.length - 1; i++) {
        let today = data[i];
        let tomorrow = data[i + 1];

        let firstDayOfMonth = false;
        let lastDayOfMonth = false;

        if (today.date.d === 1) {
            firstDayOfMonth = true;
        }

        if (today.date.m < tomorrow.date.m || (today.date.m === 12 && tomorrow.date.m === 1)) {
            lastDayOfMonth = true;
        }

        if (firstDayOfMonth) {
            currentForeign += AMOUNT_LOCAL * today.foreign;
        }

        if (lastDayOfMonth) {
            // payment missed
            if (Math.random() < chanceOfLatePayment) {
                missedPayment = currentForeign;
                daysToDelayedPayment = Math.ceil(Math.random() * 24);
                currentForeign = 0;
            } else {
                var foreignToLocal = round((1 / today.foreign) * currentForeign);
                currentLocal += foreignToLocal;
                currentForeign = 0;
                winningsPercent.push(round((foreignToLocal / AMOUNT_LOCAL) * 100));
            }
        }

        if (daysToDelayedPayment !== 0) {
            daysToDelayedPayment -= 1;

            if (daysToDelayedPayment === 0) {
                var foreignToLocal = round((0.5 / today.foreign) * missedPayment);
                winningsPercent.push(round(foreignToLocal / AMOUNT_LOCAL) * 100);
            }
        }
    }

    currentLocal = round(currentLocal);

    return winningsPercent;
}

function calculateWinningsForward(data, interestRatesDomestic, interestRatesForeign, chanceOfLatePayment) {
    let currentForeign = 0;
    let currentLocal = 0;

    let daysToDelayedPayment = 0;
    let missedPayment = 0;
    let debt = 0;
    let debtPot = 0;

    let currentForwardRate = 0;

    let winningsPercent = [];

    for (let i = 0; i < data.length - 1; i++) {
        let today = data[i];
        let tomorrow = data[i + 1];

        let firstDayOfMonth = false;
        let lastDayOfMonth = false;

        if (today.date.d === 1) {
            firstDayOfMonth = true;
        }

        if (today.date.m < tomorrow.date.m || (today.date.m === 12 && tomorrow.date.m === 1)) {
            lastDayOfMonth = true;
        }

        if (firstDayOfMonth) {
            currentForwardRate = getForwardRate(today.foreign, today.date, interestRatesDomestic, interestRatesForeign);
            currentForeign += AMOUNT_LOCAL * currentForwardRate;
        }

        if (lastDayOfMonth) {
            // payment missed
            if (Math.random() < chanceOfLatePayment) {
                missedPayment = currentForeign;
                debt = currentForeign;
                daysToDelayedPayment = Math.ceil(Math.random() * 24);
                var foreignToLocal = round((1 / currentForwardRate) * currentForeign);
                debtPot = foreignToLocal;
                currentForeign = 0;
            } else {
                var foreignToLocal = round((1 / currentForwardRate) * currentForeign);
                currentLocal += foreignToLocal;
                currentForeign = 0;
                winningsPercent.push(round((foreignToLocal / AMOUNT_LOCAL) * 100));
            }
        }

        if (debt !== 0) {
            daysToDelayedPayment -= 1;

            if (daysToDelayedPayment === 0) {
                let foreignInterest = debt - missedPayment;

                let interestInLocal = foreignInterest * (1 / today.foreign);

                winningsPercent.push(round(((debtPot - interestInLocal) / AMOUNT_LOCAL) * 100));
                debt = 0;
            }

            let daysInYear = isLeapYear(today.date.y) ? 366 : 355;
            debt += missedPayment * (1 / daysInYear);
        }
    }

    currentLocal = round(currentLocal);

    return winningsPercent;
}

function calculateWinningsOption(data, interestRatesDomestic, interestRatesForeign, volatilities, chanceOfLatePayment) {
    let currentForeign = 0;
    let currentLocal = 0;

    let daysToDelayedPayment = 0;
    let missedPayment = 0;

    let currentForwardRate = 0;
    let currentOptionPrice = 0;

    let winningsPercent = [];

    for (let i = 0; i < data.length - 1; i++) {
        let today = data[i];
        let tomorrow = data[i + 1];

        let firstDayOfMonth = false;
        let lastDayOfMonth = false;

        if (today.date.d === 1) {
            firstDayOfMonth = true;
        }

        if (today.date.m < tomorrow.date.m || (today.date.m === 12 && tomorrow.date.m === 1)) {
            lastDayOfMonth = true;
        }

        if (firstDayOfMonth) {
            currentForwardRate = getForwardRate(today.foreign, today.date, interestRatesDomestic, interestRatesForeign);
            currentOptionPrice = AMOUNT_LOCAL * getOptionPremium(today.foreign, today.date, interestRatesDomestic, interestRatesForeign, volatilities);
            currentForeign += AMOUNT_LOCAL * currentForwardRate;
        }

        if (lastDayOfMonth) {
            // payment missed
            if (Math.random() < chanceOfLatePayment) {
                missedPayment = currentForeign;
                daysToDelayedPayment = Math.ceil(Math.random() * 24);
                currentForeign = 0;
            } else {
                var foreignToLocal = round((1 / currentForwardRate) * currentForeign);
                currentLocal += foreignToLocal;
                currentForeign = 0;
                winningsPercent.push(round(((foreignToLocal - currentOptionPrice) / AMOUNT_LOCAL) * 100));
            }
        }

        if (daysToDelayedPayment !== 0) {
            daysToDelayedPayment -= 1;

            if (daysToDelayedPayment === 0) {
                var foreignToLocal = round((1 / today.foreign) * missedPayment);
                winningsPercent.push(round((foreignToLocal - currentOptionPrice) / AMOUNT_LOCAL) * 100);
            }
        }
    }

    currentLocal = round(currentLocal);

    return winningsPercent;
}

function rollTheDice() {
    return Math.round(Math.random() * 30) === 0;
}

function calculateVolatility(data) {
    let currentYear = data[0].date.y;
    let prices = [];
    let volatilities = {};

    for (let i = 0; i < data.length - 1; i++) {
        let today = data[i];
        if (currentYear === today.date.y) {
            prices.push(today.foreign);
        } else {
            volatilities[currentYear] = Math.sqrt(mathjs.variance(...prices));
            currentYear = today.date.y;
            prices = [];
            prices.push(today.foreign);
        }
    }

    volatilities['' + currentYear] = Math.sqrt(mathjs.variance(...prices));

    return volatilities;
}

// https://stackoverflow.com/questions/1184334/get-number-days-in-a-specified-month-using-javascript
function getDaysInMonth(month, year) {
    return new Date(year, month, 0).getDate();
}

// https://stackoverflow.com/questions/16353211/check-if-year-is-leap-year-in-javascript
function isLeapYear(year) {
    return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
}

function getForwardRate(spot, date, interestRatesDomestic, interestRatesForeign) {
    let daysInYear = isLeapYear(date.y) ? 366 : 355;
    let daysInMonth = getDaysInMonth(date.m, date.y);
    let fracOfYear = daysInMonth / daysInYear;

    let yearKey = '' + (date.y - 1);

    return spot * ((1 + interestRatesDomestic[yearKey] * fracOfYear) / (1 + interestRatesForeign[yearKey] * fracOfYear));
}

function getOptionPremium(spot, date, interestRatesDomestic, interestRatesForeign, volatilities) {
    let daysInYear = isLeapYear(date.y) ? 366 : 355;
    let daysInMonth = getDaysInMonth(date.m, date.y);
    let fracOfYear = daysInMonth / daysInYear;

    let yearKey = '' + (date.y - 1);

    let forwardRate = spot * ((1 + interestRatesDomestic[yearKey] * fracOfYear) / (1 + interestRatesForeign[yearKey] * fracOfYear));

    return bs.blackScholes(spot, forwardRate, fracOfYear, volatilities[yearKey], interestRatesForeign[yearKey], 'call');
}

async function getExchangeRates() {
    return new Promise((resolve, reject) => {
        fs.createReadStream('USD-EUR-1999-2020.csv')
            .pipe(csv())
            .on('data', (data) => results.push(data))
            .on('end', () => {
                resolve(results);
            });
    });
}
