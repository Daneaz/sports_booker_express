'use strict';
const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');
const moment = require('moment');
const schedule = require('node-schedule');

// static content
const URL = "https://sportshub.perfectgym.com/clientportal2/#/Login";
const FORMAT = "DD-MM-YYYY";
const REQUEST_FORMAT = "YYYY-MM-DD";
const FORMAT_WITH_TIME = "YYYY-MM-DD hh:mm a";

// scheduler counter
let counter = 0;
/* GET home page. */
router.post('/book', function (req, res, next) {
    console.log(req.body)
    let requestTime = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME)

    let scheduleDate = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(15, "seconds").subtract(7, "days");

    // scheduleDate = moment().add(5, "seconds");

    console.log(`Current job count: ${counter}`)
    if (counter >= 5) {
        res.send(`Max scheduler = 5, Current scheduler= ${counter}`)
    } else {
        counter++;
        console.log(`Job has scheduled for ${req.body.type.text} on ${scheduleDate.toLocaleString()}... Current job count: ${counter}`)
        res.send(`Job has scheduled for ${req.body.type.text} on ${requestTime.format(FORMAT_WITH_TIME)}... Current job count: ${counter}`)
        schedule.scheduleJob(scheduleDate.toDate(), function () {
            console.log("Starting to run booker...")
            runBooker(req);
            counter--;
            console.log(`Current job count: ${counter}`)
        }.bind(null, req));
    }
});

async function runBooker(req) {
    let requestDate = moment.unix(req.body.date / 1000).format(REQUEST_FORMAT)
    let requestTime = moment(`${moment.unix(req.body.date / 1000).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME)

    // inputs
    const bookingURL = `https://sportshub.perfectgym.com/clientportal2/#/FacilityBooking?clubId=1&zoneTypeId=${req.body.type.value}&date=${requestDate}`
    const duration = req.body.duration;
    const username = req.body.email;
    const password = req.body.password;

    const browser = await puppeteer.launch();

    try {
        console.log("Loading...")
        const page = await browser.newPage();
        await page.goto(URL);
        await page.waitForNetworkIdle()

        // login
        console.log("Login...")
        await page.type(".baf-field-input.ng-valid", username);
        await page.type(".baf-field-input.baf-password-input", password);
        await page.click(".cp-btn-next.cp-login-btn-login");

        // navigation
        console.log("Navigating to booking page...")
        await page.goto(bookingURL);
        await page.waitForNetworkIdle();

        console.log(`Searching for ${req.body.type.text} slot...`)
        const timingBoxes = await page.$$('table tr td');
        let targetBox = timingBoxes[await findTargetSlot(page, requestDate, req.body.time)];
        let targetSlotBookBtn = await targetBox.$('.cp-btn-classes-action');
        await targetSlotBookBtn.click();
        await page.waitForNetworkIdle();

        if (duration > 60) {
            console.log("Configuring for target slot duration...")
            let durationBtn = await page.$('[name="selectedDuration"]');
            await durationBtn.click();
            await page.waitForNetworkIdle();
            let durationSlot = await page.$('.scroll-wrapper.baf-scroll-panel-inner');
            let slots = await durationSlot.$$('span');
            if (slots.length > 1) {
                await page.keyboard.press('ArrowDown');
                await page.keyboard.press('Enter');
                await page.click(".cp-btn-next");
                await page.waitForNetworkIdle();

                console.log("Trying to book slot...")
                await bookingSlot(page, requestTime);

                console.log("Done...")
                await browser.close();
            } else {
                console.log(`Error: No ${duration} mins slot found...`)
                await browser.close();
            }
        } else {
            await page.click(".cp-btn-next");
            await page.waitForNetworkIdle();

            console.log("Booking for target slot...")
            await bookingSlot(page, requestTime);

            console.log("Done...")
            await browser.close();
        }

    } catch (err) {
        console.log("Unknown error: " + err);

        await browser.close();
    }
}

async function findTargetSlot(page, dateString, timeString) {
    let requestDate = moment(dateString);

    let colHeader = await page.evaluate(() => {
        const tds = Array.from(document.querySelectorAll('.cp-calendar-date'))
        return tds.map(td => td.innerText)
    });

    let colNum;
    for (let i = 0; i < colHeader.length; i++) {
        let dateAndMonth = colHeader[i].split('/');
        if (dateAndMonth[0].length < 2) {
            dateAndMonth[0] = `0${dateAndMonth[0]}`;
        }
        if (dateAndMonth[1].length < 2) {
            dateAndMonth[1] = `0${dateAndMonth[1]}`;
        }
        let date = `${dateAndMonth[0]}/${dateAndMonth[1]}/${moment().year()}`
        if (moment(date, FORMAT).valueOf() === requestDate.valueOf()) {
            colNum = i;
            break;
        }
    }

    let rowHeader = await page.evaluate(() => {
        const tds = Array.from(document.querySelectorAll('.cp-calendar-side-col'))
        return tds.map(td => td.innerText)
    });

    rowHeader = await rowHeader.filter(value => {
        if (value !== "")
            return value;
    })

    let rowNum;
    for (let i = 0; i < rowHeader.length; i++) {
        if (rowHeader[i] === timeString) {
            rowNum = i;
        }
    }

    return colNum + 1 + rowNum * (colHeader.length + 2);
}

async function bookingSlot(page, requestTime) {
    try {

        let expiredTime = requestTime.add(60, 'seconds')
        while (moment.now() < expiredTime.valueOf()) {
            console.log("Booking for target slot...")
            let addToCartBtn = await page.$('[text="Add to cart"]');
            if (addToCartBtn) {
                console.log("Booking with [Add to cart]...")
                await addToCartBtn.click();
                await page.waitForNetworkIdle();
                let bookNowBtn = await page.$('[text="Book now"]');
                if (bookNowBtn) {
                    await bookNowBtn.click();
                    await page.waitForNetworkIdle();
                } else {
                    let model = await page.$('.cp-modal-content.cp-facility-modal');
                    if (model) {
                        let bookBtn = await model.$('[text="Book"]')
                        if(bookBtn) {
                            await bookBtn.click();
                            await page.waitForNetworkIdle();
                        }
                    }
                }
            } else {
                console.log("Booking with [Book]...")
                let model = await page.$('.cp-modal-content.cp-facility-modal');
                if (model) {
                    let bookBtn = await model.$('[text="Book"]')
                    await bookBtn.click();
                    await page.waitForNetworkIdle();
                }
            }
            let closeBtn = await page.$('[text="Close"]');
            if (closeBtn) {
                break;
            }
            await delay(500);
        }
    } catch (err) {
        console.log(err)
    }
}

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}


module.exports = router;
