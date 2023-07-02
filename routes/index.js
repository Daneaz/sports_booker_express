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
    let scheduleDate = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(20, "seconds").subtract(7, "days");
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

        if (isSchedule) {
            let slots = await checkingSlot(req, res);
            if (slots.length < 1) {
                return res.status(400).json(`Checking slot fail. There's no slots available on ${requestDate} ${req.body.time}`)
            }

            counter++;
            logger.info(`Job has scheduled for ${req.body.type.text} on ${scheduleDate.toLocaleString()}... Current job count: ${counter}`)

            schedule.scheduleJob(scheduleDate.toDate(), function () {
                logger.info("Starting to run booker...")
                bookingSlot(req);
                counter--;
                logger.info(`Current job count: ${counter}`)
            }.bind(null, req));
            msg = msg + `, Current available slots: ${slots.length}`
            return res.status(200).json(msg);
        } else {
            logger.info("Slot release time has pass, trying to book now.")
            await bookingSlot(req, res);

            return res.status(200).json("Booking Success, Please process to payment.");
        }

    }
});


async function login(req, res, cookies) {
    try {
        let data = {
            "Login": req.body.email,
            "Password": req.body.password,
            "RememberMe": false,
        }

        let response = await axios.post(LOGIN_API, data)

        stackUpCookies(cookies, response.headers["set-cookie"])

        logger.info(`LoggingIn with userId: ${response.data.User.Member.Id}`)
        return response.data.User.Member.Id;
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

        let userId = await login(req, res, cookies);

        return await getAvailableSlot(req, res, cookies, userId, requestDate, requestDateTime);
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

        let userId = await login(req, res, cookies);

        if (!userId) {
            logger.info("Login Fail")
            if (res) {
                return res.status(400).json(`Login Fail`);
            } else {
                return;
            }
        }

        let zoneIds = await getAvailableSlot(req, res, cookies, userId, requestDate, requestDateTime);

        if (zoneIds.length < 1) {
            logger.info("No available slots")
            if (res) {
                return res.status(400).json(`No available slots`);
            } else {
                return;
            }
        }


        let detailList = await fillUpDetail(req, res, cookies, userId, zoneIds, requestDate, requestDateTime);


        if (detailList.length < 1) {
            logger.info("Filling Up Detail error, unable to query detail")
            if (res) {
                return res.status(400).json(`Filling Up Detail error, unable to query detail`);
            } else {
                return;
            }
        }


        let holdingTime = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(1, 'seconds')
        let expiredTime = moment().add(30, 'minutes')
        let status = 499;
        let counter = 1;

        while (status !== 200 && moment.now() < expiredTime.valueOf() && counter < 50) {
            if (moment.now() < holdingTime.valueOf()) {
                logger.info("Holding time Please wait...")
                await delay(500);
                continue;
            }
            logger.info(`Trying ${counter}`)
            status = await bookSlot(res, detailList);
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
        let zoneIds = [];
        for (let i = 0; i < zones.length; i++) {
            if (slots[zones[i].Id][requestDateTime][req.body.duration]) {
                zoneIds.push(zones[i].Id);
            }
        }

        if (zoneIds.isEmpty) {
            logger.info("No available slots")
            if (res) {
                return res.status(400).json(`No available slots`);
            } else {
                return;
            }
        }

        logger.info(`sessionId: ${response.headers.get("cp-book-facility-session-id")}`)

        return {
            zoneIds: zoneIds,
            sessionCookies: response.headers["set-cookie"],
            sessionId: response.headers.get("cp-book-facility-session-id")
        }
    } catch (err) {
        logger.error(`Unknown Exception, ObtainSession, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        }
    }
}

async function getAvailableSlot(req, res, cookies, userId, requestDate, requestDateTime) {
    try {
        const GET_SESSION_API = `https://sportshub.perfectgym.com/clientportal2/FacilityBookings/BookFacility/Start?RedirectUrl=https:%2F%2Fsportshub.perfectgym.com%2Fclientportal2%2F%23%2FFacilityBooking%3FclubId%3D1%26zoneTypeId%3D${req.body.type.value}%26date%3D${requestDate}&clubId=1&startDate=${requestDateTime}&zoneTypeId=${req.body.type.value}`;
        let response = await axios.get(GET_SESSION_API, {
            headers: {
                cookie: cookies
            }
        })
        let slots = response.data.Data.UsersBookingPossibilities[userId].PossibleDurations;
        let zones = response.data.Data.Zones;
        let zoneIds = [];
        for (let i = 0; i < zones.length; i++) {
            if (slots[zones[i].Id][requestDateTime][req.body.duration]) {
                zoneIds.push(zones[i].Id);
            }
        }

        logger.info(`Available slots: ${zoneIds}`)
        return zoneIds;
    } catch (err) {
        logger.error(`Unknown Exception, ObtainSession, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        }
    }
}

async function fillUpDetail(req, res, cookies, userId, zoneIds, requestDate, requestDateTime) {
    try {
        let duration = req.body.duration;
        let detailList = [];
        for (let i = 0; i < zoneIds.length; i++) {
            let {
                sessionId,
                sessionCookies
            } = await obtainSession(req, res, cookies, userId, requestDate, requestDateTime);
            let tempCookies = [...cookies];
            stackUpCookies(tempCookies, sessionCookies)

            let data = {
                "UserId": userId,
                "ZoneId": zoneIds[i],
                "StartTime": requestDateTime,
                "RequiredNumberOfSlots": null,
                "Duration": duration
            }
            let response = await axios.post(QUERY_DETAIL_API, data, {
                headers: {
                    "cookie": tempCookies,
                    "cp-book-facility-session-id": sessionId
                }
            })

            let detailCookies = response.headers["set-cookie"]
            stackUpCookies(tempCookies, detailCookies)
            let detail = {
                ruleId: response.data.Data.RuleId,
                sessionId: sessionId,
                cookies: tempCookies
            }
            logger.info(`Obtained ruleId: ${response.data.Data.RuleId}, sessionId: ${sessionId}`)
            detailList.push(detail);
        }

        return detailList;
    } catch (err) {
        logger.error(`Unknown Exception, FillUpDetail, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        }
    }
}

async function bookSlot(res, detailList) {
    try {
        let apiCalls = [];
        for (let i = 0; i < detailList.length; i++) {

            let data = {
                "ruleId": detailList[i].ruleId,
                "OtherCalendarEventBookedAtRequestedTime": false,
                "HasUserRequiredProducts": false,
                "ShouldBuyRequiredProductOnDebit": true
            }

            let apiCall = axios.post(BOOKING_API, data, {
                headers: {
                    "cookie": detailList[i].cookies,
                    "cp-book-facility-session-id": detailList[i].sessionId
                },
                validateStatus: function (status) {
                    return status < 600;
                }
            })
            apiCalls.push(apiCall);
        }

        const responses = await Promise.all(apiCalls);

        for (let i = 0; i < responses.length; i++) {
            if (responses[i] && responses[i].status) {
                if (responses[i].status === 200) {
                    logger.info(`Booking Success, Status: ${responses[i].status}, Message: ${responses[i].data}`)
                    return responses[i].status;
                } else if (responses[i].status === 499) {
                    logger.info(`Slot not ready, Status: ${responses[i].status}, Message: ${responses[i].data}`)
                } else if (responses[i].status === 502) {
                    logger.info(`Server Error, Status: ${responses[i].status}`)
                } else if (responses[i].status === 503) {
                    logger.info(`Server Error, Status: ${responses[i].status}`)
                } else {
                    logger.info(`Unknown Error, Status: ${responses[i].status}, Message: ${responses[i].data}`)
                }
            }
        }
        return 499;
    } catch (err) {
        logger.error(`Unknown Exception, BookSlot, Error: ${err}`)
        if (res) {
            return res.status(400).json(`Unknown Exception`);
        } else {
            return 500;
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
