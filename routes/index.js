'use strict';
const express = require('express');
const router = express.Router();
const moment = require('moment');
const schedule = require('node-schedule');
const logger = require('../logger');
const axios = require('axios');
const nodemailer = require('nodemailer');


axios.defaults.withCredentials = true


// const transporter = nodemailer.createTransport({
//     service: 'gmail',
//     auth: {
//         user: process.env.email,
//         pass: process.env.password
//     }
// });


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
    let scheduleDate = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(40, "seconds").subtract(7, "days");
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

        let holdingTime = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(7, "days").subtract(2, 'seconds')

        while (moment.now() < holdingTime.valueOf()) {
            logger.info("Holding time Please wait...")
            await delay(500);
        }
        await bookSlot(res, detailList);

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
    let expiredTime = moment().add(15, 'minutes')
    const counterMap = new Map();
    const detailMap = new Map();

    let isCompleted = false;

    for (let i = 0; i < detailList.length; i++) {
        counterMap.set(detailList[i].sessionId, 1);
        detailMap.set(detailList[i].sessionId, detailList[i]);
    }

    while (!isCompleted && moment.now() < expiredTime && detailMap.size > 0) {
        for (const [key, detail] of detailMap.entries()) {
            let data = {
                "ruleId": detail.ruleId,
                "OtherCalendarEventBookedAtRequestedTime": false,
                "HasUserRequiredProducts": false,
                "ShouldBuyRequiredProductOnDebit": true
            }
            logger.info(`Firing request to OCBC server...., SessionId: ${key}`)
            try {
                let response = await axios.post(BOOKING_API, data, {
                    timeout: 15000,
                    headers: {
                        "cookie": detail.cookies,
                        "cp-book-facility-session-id": key
                    },
                    validateStatus: function (status) {
                        return status < 600;
                    }
                })

                if (response) {
                    switch (response.status) {
                        case 200:
                            // sendEmail(req.body.email, requestDateTime);
                            logger.info(`Booking Success, Status: ${response.status}, Message: ${response.data}, SessionId: ${key}`)
                            isCompleted = true;
                            break;
                        case 499:
                            logger.info(`Slot not ready, Status: ${response.status}, Message: ${response.data}, SessionId: ${key}, Trying ${counterMap.get(key)}`)
                            if (counterMap.get(key) >= 5) {
                                detailMap.delete(key)
                                logger.info(`Removing session, SessionId: ${key}`)
                            }
                            counterMap.set(key, counterMap.get(key) + 1)
                            break;
                        case 500:
                            logger.info(`Server Error, Status: ${response.status}, Message: ${response.data}, SessionId: ${key}, Trying ${counterMap.get(key)}`)
                            if (counterMap.get(key) >= 5) {
                                detailMap.delete(key)
                                logger.info(`Removing session, SessionId: ${key}`)
                            }
                            counterMap.set(key, counterMap.get(key) + 1)
                            break;
                        case 502:
                        case 503:
                            logger.info(`Server Error, Status: ${response.status}, SessionId: ${key}`)
                            break;
                        default:
                            logger.info(`Unknown Status, Status: ${response.status}, Message: ${response.data}, SessionId: ${key}`)
                            break;
                    }
                }
                if (isCompleted) {
                    break;
                }
            } catch (err) {
                logger.error(`Unknown Exception, BookSlot fail, Error: ${err}, SessionId: ${key}`)
            }
        }
    }
    if (res && isCompleted){
        return res.status(200).json(`Booking Success, Please proceed to payment.`);
    } else if (res){
        return res.status(400).json(`Booking Fail, No slots available`);
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


// function sendEmail(email, requestDateTime) {
//     let mailOptions = {
//         from: process.env.email,
//         to: email,
//         subject: `Booking Success`,
//         text: `Your booking on ${requestDateTime} is SUCCESS`
//     };
//
//     transporter.sendMail(mailOptions, function (error, info) {
//         if (error) {
//             logger.error(error);
//         } else {
//             logger.info(`Email sent: ${info.response}`);
//         }
//     });
//
// }

module.exports = router;
