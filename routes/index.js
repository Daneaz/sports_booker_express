'use strict';
const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');
const moment = require('moment');
const schedule = require('node-schedule');
const logger = require('../logger');

// static content
const URL = "https://sportshub.perfectgym.com/clientportal2/#/Login";
const FORMAT = "DD-MM-YYYY";
const REQUEST_FORMAT = "YYYY-MM-DD";
const FORMAT_WITH_TIME = "YYYY-MM-DD hh:mm a";

// scheduler counter
let counter = 0;

/* GET home page. */
router.post('/book', async function (req, res, next) {

    let requestDate = moment(new Date(req.body.date)).format(REQUEST_FORMAT)
    let scheduleDate = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(15, "seconds").subtract(7, "days");
    let isSchedule = false;
    let msg;
    if (moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).valueOf() <= moment().add(7, "days").valueOf()) {
        scheduleDate = moment().add(15, "seconds");
        msg = "Slot release time has pass, trying to book now. You will receive a email once the slot is found."
    } else {
        isSchedule = true;
        msg = `Task has scheduled for ${req.body.type.text} on ${scheduleDate.format(FORMAT_WITH_TIME)}... Current scheduled task number: ${counter + 1}`
    }

    logger.info(`Current job count: ${counter}`)
    if (counter >= 5) {
        return res.status(400).json(`Max scheduler = 5, Current scheduler= ${counter}`);
    } else {

        if (isSchedule && !await checkingSlot(req)) {
            return res.status(400).json(`No slots available on ${requestDate} ${req.body.time}`)
        } else {

            counter++;
            logger.info(`Job has scheduled for ${req.body.type.text} on ${scheduleDate.toLocaleString()}... Current job count: ${counter}`)


            schedule.scheduleJob(scheduleDate.toDate(), function () {
                logger.info("Starting to run booker...")
                runBooker(req);
                counter--;
                logger.info(`Current job count: ${counter}`)
            }.bind(null, req));
            return res.status(200).json(msg);
        }
    }
});


async function loginAndNavigate(req) {

    let requestDate = moment(new Date(req.body.date)).format(REQUEST_FORMAT)

    // inputs
    const bookingURL = `https://sportshub.perfectgym.com/clientportal2/#/FacilityBooking?clubId=1&zoneTypeId=${req.body.type.value}&date=${requestDate}`
    const username = req.body.email;
    const password = req.body.password;

    const browser = await puppeteer.launch();
    try {

        logger.info("Loading...")
        const page = await browser.newPage();
        await page.goto(URL);
        await page.waitForNetworkIdle()

        // login
        logger.info("Login...")
        await page.type(".baf-field-input.ng-valid", username);
        await page.type(".baf-field-input.baf-password-input", password);
        await page.click(".cp-btn-next.cp-login-btn-login");


        // navigation
        logger.info("Navigating to booking page...")
        await page.goto(bookingURL);
        await page.waitForNetworkIdle();

        logger.info(`Searching for ${req.body.type.text} slot...`)
        const timingBoxes = await page.$$('table tr td');
        logger.info(`Total slot count ${timingBoxes.length}`)
        let targetBox = timingBoxes[await findTargetSlot(page, requestDate, req.body.time)];
        return {targetBox, browser, page};
    } catch (err) {
        logger.error("Unknown error: " + err);
        await browser.close();
    }
}

async function checkingSlot(req) {
    let {targetBox, browser, page} = await loginAndNavigate(req);
    try {
        let targetSlotBookBtn = await targetBox.$('.cp-btn-classes-action');
        await browser.close();
        if (targetSlotBookBtn) {
            return true;
        } else {
            logger.warn("No Slot found...")
            return false;
        }
    } catch (err) {
        logger.error("Unknown error: " + err);
        await browser.close();
    }
}

async function runBooker(req) {
    let {targetBox, browser, page} = await loginAndNavigate(req);

    try {
        if (targetBox) {
            let targetSlotBookBtn = await targetBox.$('.cp-btn-classes-action');
            await targetSlotBookBtn.click();
            await page.waitForNetworkIdle();
        } else {
            logger.warn("No Slot found...")
            await browser.close();
            return;
        }

        await recursiveBooking(req, targetBox, browser, page)

    } catch (err) {
        logger.error("Unknown error: " + err);

        await browser.close();
    }
}

async function recursiveBooking(req, targetBox, browser, page) {
    let requestTime = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME)
    const duration = req.body.duration;
    try {
        if (duration > 60) {
            logger.info("Configuring for target slot duration...")
            let durationBtn = await page.$('[name="selectedDuration"]');
            await durationBtn.click();
            await page.waitForNetworkIdle({timeout: 5000});
            let durationSlot = await page.$('.scroll-wrapper.baf-scroll-panel-inner');
            let slots = await durationSlot.$$('span');
            if (slots.length > 1) {
                await page.keyboard.press('ArrowDown');
                await page.keyboard.press('Enter');
                await page.click(".cp-btn-next");
                await page.waitForNetworkIdle({timeout: 5000});

                logger.info("Trying to book slot...")
                await bookingSlot(page, requestTime);

                logger.info("Done...")
                await browser.close();
            } else {
                logger.warn(`No ${duration} mins slot found...`)
                await browser.close();
            }
        } else {
            await page.click(".cp-btn-next");
            await page.waitForNetworkIdle({timeout: 5000});

            logger.info("Booking for target slot...")
            await bookingSlot(page, requestTime);

            logger.info("Done...")
            await browser.close();
        }
    } catch (err){
        logger.error(err);
        await recursiveBooking(req, targetBox, browser, page);
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
    logger.info(`Date: ${colHeader}`)
    logger.info(`Request Date: ${dateString}`)
    logger.info(`Time: ${rowHeader}`)
    logger.info(`Request Time: ${timeString}`)
    logger.info(`Target slot count: ${colNum + 1 + rowNum * (colHeader.length + 2)}`)

    return colNum + 1 + rowNum * (colHeader.length + 2);
}

async function bookingSlot(page, requestTime) {
    try {
        let expiredTime = requestTime.add(60, 'seconds')
        while (moment.now() < expiredTime.valueOf()) {
            logger.info("Booking for target slot...")
            let addToCartBtn = await page.$('[text="Add to cart"]');
            if (addToCartBtn) {
                logger.info("Booking with [Add to cart]...")
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
                        if (bookBtn) {
                            await bookBtn.click();
                            await page.waitForNetworkIdle();
                        }
                    }
                }
            } else {
                logger.info("Booking with [Book]...")
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
        logger.error(err)
    }
}

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}


module.exports = router;
