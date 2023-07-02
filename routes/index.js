'use strict';
const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');
const moment = require('moment');
const schedule = require('node-schedule');
const logger = require('../logger');
const axios = require('axios');

axios.defaults.withCredentials = true

// static content
const LOGIN_API = "https://sportshub.perfectgym.com/clientportal2/Auth/Login"
const QUERY_DETAIL_API = "https://sportshub.perfectgym.com/clientportal2/FacilityBookings/WizardSteps/SetFacilityBookingDetailsWizardStep/Next";
const BOOKING_API = "https://sportshub.perfectgym.com/clientportal2/FacilityBookings/WizardSteps/ChooseBookingRuleStep/Next"

const REQUEST_FORMAT = "YYYY-MM-DD";
const FORMAT_WITH_TIME = "YYYY-MM-DD hh:mm a";
const FORMAT_DATETIME = "YYYY-MM-DDTHH:mm:ss";
// scheduler counter
let counter = 0;

/* GET home page. */
router.post('/book', async function (req, res, next) {

    let requestDate = moment(new Date(req.body.date)).format(REQUEST_FORMAT)
    let scheduleDate = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(7, "seconds").subtract(7, "days");
    let isSchedule;
    let msg;
    if (moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).valueOf() <= moment().add(7, "days").valueOf()) {
        isSchedule = false
    } else {
        isSchedule = true;
        msg = `Task has scheduled for ${req.body.type.text} on ${scheduleDate.format(FORMAT_WITH_TIME)}... Current scheduled task number: ${counter + 1}`
    }

    logger.info(`Current job count: ${counter}`)
    if (counter >= 5) {
        return res.status(400).json(`Max scheduler = 5, Current scheduler= ${counter}`);
    } else {

        if (isSchedule && !await checkingSlot(req, res)) {
            return res.status(400).json(`Checking slot fail. There's no slots available on ${requestDate} ${req.body.time}`)
        }

        if (isSchedule) {
            counter++;
            logger.info(`Job has scheduled for ${req.body.type.text} on ${scheduleDate.toLocaleString()}... Current job count: ${counter}`)

            schedule.scheduleJob(scheduleDate.toDate(), function () {
                logger.info("Starting to run booker...")
                bookingSlot(req);
                counter--;
                logger.info(`Current job count: ${counter}`)
            }.bind(null, req));
            return res.status(200).json(msg);
        } else {
            logger.info("Slot release time has pass, trying to book now.")
            await bookingSlot(req, res);

            return res.status(200).json("Booking Success, Please process to payment.");
        }

    }
});


async function login(req, res) {
    try {
        let data = {
            "Login": req.body.email,
            "Password": req.body.password,
            "RememberMe": false,
        }

        let response = await axios.post(LOGIN_API, data)


        return {userId: response.data.User.Member.Id, loginCookies: response.headers["set-cookie"]}
    } catch (err) {
        logger.error(`Unknown Exception, Login, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        }
    }
}


async function checkingSlot(req, res) {
    try {
        let requestDate = moment(new Date(req.body.date)).format(REQUEST_FORMAT)
        let requestDateTime = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).format(FORMAT_DATETIME)

        let cookies = [];

        let {userId, loginCookies} = await login(req, res);
        stackUpCookies(cookies, loginCookies)

        let {zoneId} = await obtainSession(req, res, cookies, userId, requestDate, requestDateTime);

        if (!zoneId) {
            logger.info("No available slots")
            return false;
        }
        return true;

    } catch (err) {
        logger.error(`Unknown Exception, checkingSlot, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        }
    }

}

async function bookingSlot(req, res = null) {
    try {
        let requestDate = moment(new Date(req.body.date)).format(REQUEST_FORMAT)
        let requestDateTime = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).format(FORMAT_DATETIME)

        let cookies = [];

        let {userId, loginCookies} = await login(req, res);
        stackUpCookies(cookies, loginCookies);
        logger.info(`LoggingIn with userId: ${userId}`)

        if(!userId){
            logger.info("Login Fail")
            if (res){
                return res.status(400).json(`Login Fail`);
            } else {
                return ;
            }
        }

        let {zoneId, sessionId, sessionCookies} = await obtainSession(req, res, cookies, userId, requestDate, requestDateTime);
        stackUpCookies(cookies, sessionCookies)

        if (!zoneId) {
            logger.info("No available slots")
            if (res){
                return res.status(400).json(`No available slots`);
            } else {
                return ;
            }
        }
        logger.info(`Obtained session with zoneId: ${zoneId}, sessionId: ${sessionId}`)


        let {ruleId, ruleCookies} = await fillUpDetail(cookies, userId, zoneId, sessionId, requestDateTime, req.body.duration, res);
        stackUpCookies(cookies, ruleCookies)

        logger.info(`Obtained ruleId: ${ruleId}`)

        let expiredTime = moment().add(30, 'minutes')
        let status = 499;
        let counter = 1;
        while (status !== 200 && moment.now() < expiredTime.valueOf() && counter < 50) {
            logger.info(`Trying ${counter}`)
            status = await bookSlot(cookies, sessionId, ruleId, res);
            await delay(500);
            counter++;
        }
        return status;
    } catch (err) {
        logger.error(`Unknown Exception, bookingSlot, Error: ${err}`)
        return res.status(400).json(`Unknown Exception`);
    }

}

async function obtainSession(req, res, cookies, userId, requestDate, requestDateTime) {
    try {
        const GET_SESSION_API = `https://sportshub.perfectgym.com/clientportal2/FacilityBookings/BookFacility/Start?RedirectUrl=https:%2F%2Fsportshub.perfectgym.com%2Fclientportal2%2F%23%2FFacilityBooking%3FclubId%3D1%26zoneTypeId%3D${req.body.type.value}%26date%3D${requestDate}&clubId=1&startDate=${requestDateTime}&zoneTypeId=${req.body.type.value}`;
        let response = await axios.get(GET_SESSION_API, {
            headers: {
                cookie: cookies
            }
        })
        let slots = response.data.Data.UsersBookingPossibilities[userId].PossibleDurations;
        let zones = response.data.Data.Zones;
        let zoneId;
        //TODO can be optimise by obtain a list of zoneIds, can pass down, and parallel call for each zoneId
        for (let i = zones.length - 1; i >= 0; i--) {
            if (slots[zones[i].Id][requestDateTime][req.body.duration]) {
                zoneId = zones[i].Id;
                break;
            }
        }


        return {
            zoneId: zoneId,
            sessionId: response.headers.get("cp-book-facility-session-id"),
            sessionCookies: response.headers["set-cookie"]
        }
    } catch (err) {
        logger.error(`Unknown Exception, ObtainSession, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        }
    }
}

async function fillUpDetail(cookies, userId, zoneId, sessionId, requestDateTime, duration, res) {
    try {
        let data = {
            "UserId": userId,
            "ZoneId": zoneId,
            "StartTime": requestDateTime,
            "RequiredNumberOfSlots": null,
            "Duration": duration
        }

        let response = await axios.post(QUERY_DETAIL_API, data, {
            headers: {
                "cookie": cookies,
                "cp-book-facility-session-id": sessionId
            }
        })

        return {ruleId: response.data.Data.RuleId, ruleCookies: response.headers["set-cookie"]}
    } catch (err) {
        logger.error(`Unknown Exception, FillUpDetail, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        }
    }
}

async function bookSlot(cookies, sessionId, ruleId, res) {
    try {
        let data = {
            "ruleId": ruleId,
            "OtherCalendarEventBookedAtRequestedTime": false,
            "HasUserRequiredProducts": false,
            "ShouldBuyRequiredProductOnDebit": true
        }

        let response = await axios.post(BOOKING_API, data, {
            headers: {
                "cookie": cookies,
                "cp-book-facility-session-id": sessionId
            }
        })

        if (response.status === 200) {
            logger.info("Booking Success")
        }

        return response.status;
    } catch (err) {
        if (err.response && err.response.status) {
            if (err.response.status === 499) {
                logger.info("Slot is not ready yet")
                return 499;
            } else if (err.response.status >= 400) {
                logger.info(err)
                return err.response.status;
            }
        } else {
            logger.error(`Unknown Exception, BookSlot, Error: ${err}`)
            if (res) {
                return res.status(400).json(`Unknown Exception`);
            } else {
                return 500;
            }
        }
    }
}

function stackUpCookies(origin, newCookies) {
    if (newCookies != null) {
        for (let i = 0; i < newCookies.length; i++) {
            origin.push(newCookies[i]);
        }
    }
}

function delay(time) {
    return new Promise(function (resolve) {
        setTimeout(resolve, time)
    });
}


module.exports = router;
