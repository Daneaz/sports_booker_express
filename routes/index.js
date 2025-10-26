'use strict';
const express = require('express');
const router = express.Router();
const moment = require('moment');
const schedule = require('node-schedule');
const logger = require('../logger');
const axios = require('axios');
const twilio = require('twilio')

const client = twilio(process.env.TwilioSid, process.env.TwilioToken);

const callWhiteList = [
    "eugenewwj@gmail.com",
    "guo_sha@hotmail.com",
    "naruto921210@gmail.com"
]

const emailToPhone = new Map();

// 添加数据
emailToPhone.set("eugenewwj@gmail.com", "+6597985397");
emailToPhone.set("guo_sha@hotmail.com", "+6583660520");

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

router.post("/voice", (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say({voice: "alice"}, "Booking Success, Thank You");
    res.type("text/xml");
    res.send(twiml.toString());
});

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

        logger.info(`LoggingIn with userId: ${response.data.User.Member.Id}, FirstName: ${response.data.User.Member.FirstName}, LastName: ${response.data.User.Member.LastName}`)
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

        let bookingTime = moment(`${moment(new Date(req.body.date)).format(REQUEST_FORMAT)} ${req.body.time}`, FORMAT_WITH_TIME).subtract(7, "days")
        // cal for holding time, 网络延迟181ms
        let holdingTime = bookingTime.valueOf() - moment.now() - 100
        logger.info(`Holding time Please wait ${holdingTime / 1000} seconds... (${holdingTime} milliseconds)`)
        await delay(holdingTime);

        // 传递所有必要的参数给bookSlot函数，以便在遇到499状态时可以刷新session
        await bookSlot(res, detailList, req, userId, cookies, requestDate, requestDateTime);

    } catch (err) {
        logger.error(`Unknown Exception, bookingSlot, Error: ${err}`)
        return res.status(400).json(`Unknown Exception`);
    }

}

async function obtainSession(req, res, cookies, userId, requestDate, requestDateTime) {
    try {
        const GET_SESSION_API = `https://sportshub.perfectgym.com/clientportal2/FacilityBookings/BuyProductBeforeBookingFacility/Start?RedirectUrl=https:%2F%2Fsportshub.perfectgym.com%2Fclientportal2%2F%23%2FFacilityBooking%3FclubId%3D1%26zoneTypeId%3D${req.body.type.value}%26date%3D${requestDate}&clubId=1&startDate=${requestDateTime}&zoneTypeId=${req.body.type.value}`
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

        logger.info(`sessionId: ${response.headers.get("cp-buy-product-before-booking-fb-session-id")}`)

        return {
            zoneIds: zoneIds,
            sessionCookies: response.headers["set-cookie"],
            sessionId: response.headers.get("cp-buy-product-before-booking-fb-session-id")
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
                    "cp-buy-product-before-booking-fb-session-id": sessionId
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

async function bookSlot(res, detailList, req = null, userId = null, cookies = null, requestDate = null, requestDateTime = null) {
    let expiredTime = moment().add(35, 'minutes')
    const counterMap = new Map();
    const detailMap = new Map();

    let isCompleted = false;
    let cartCheckInterval = null;

    for (let i = 0; i < detailList.length; i++) {
        counterMap.set(detailList[i].sessionId, 1);
        detailMap.set(detailList[i].sessionId, detailList[i]);
    }

    // 启动并发查询购物车的进程
    const checkShoppingCart = () => {
        // 使用Promise.race来处理超时
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Cart check timeout')), 2000)
        );

        const cartCheckPromise = axios.get('https://sportshub.perfectgym.com/clientportal2/Shopping/ShoppingCart/GetShoppingCartSummary', {
            headers: {
                "cookie": detailList[0].cookies // 使用第一个详情的cookies
            },
            validateStatus: function (status) {
                return status < 600;
            }
        })
            .then(cartResponse => {
                if (cartResponse && cartResponse.status === 200 && cartResponse.data) {
                    logger.info(`Shopping Cart Summary: ${JSON.stringify(cartResponse.data)}`);
                    // 检查购物车数量是否大于0
                    if (cartResponse.data.TotalQuantity > 0 && cartResponse.data.TotalAmount.Gross > 0) {
                        logger.info(`Items found in cart, TotalQuantity: ${cartResponse.data.TotalQuantity}, marking as completed`);
                        isCompleted = true;
                        // 如果设置了定时器，清除它
                        if (cartCheckInterval) {
                            clearInterval(cartCheckInterval);
                            cartCheckInterval = null;
                        }
                    }
                }
                return cartResponse;
            })
            .catch(cartErr => {
                logger.error(`Failed to check shopping cart: ${cartErr}`);
            });

        return Promise.race([cartCheckPromise, timeoutPromise]).catch(err => {
            logger.error(`Cart check race error: ${err}`);
        });
    };

    // 启动定时查询购物车，每5秒检查一次
    cartCheckInterval = setInterval(checkShoppingCart, 5000);


    while (!isCompleted && moment.now() < expiredTime) {
        // 如果需要刷新 session
        if (detailMap.size === 0) {
            logger.info(`Refreshing ${detailMap.size} sessions with status 499`);
            let newZoneIds = await getAvailableSlot(req, res, cookies, userId, requestDate, requestDateTime);

            if (newZoneIds && newZoneIds.length > 0) {
                let newDetailList = await fillUpDetail(req, res, cookies, userId, newZoneIds, requestDate, requestDateTime);

                if (newDetailList && newDetailList.length > 0) {
                    for (let i = 0; i < newDetailList.length; i++) {
                        counterMap.set(newDetailList[i].sessionId, 1);
                        detailMap.set(newDetailList[i].sessionId, newDetailList[i]);
                        logger.info(`Added new session: ${newDetailList[i].sessionId} to execution flow`);
                    }
                }
            }
        }

        // === 👇 并行调用开始 ===
        const bookingPromises = [];

        for (const [key, detail] of detailMap.entries()) {
            const data = {
                "ruleId": detail.ruleId,
                "OtherCalendarEventBookedAtRequestedTime": false,
                "HasUserRequiredProducts": false,
                "ShouldBuyRequiredProductOnDebit": true
            };

            bookingPromises.push(
                (async () => {
                    logger.info(`Firing parallel request to OCBC server...., SessionId: ${key}`);
                    try {
                        const response = await axios.post(BOOKING_API, data, {
                            timeout: 1000,
                            headers: {
                                "cookie": detail.cookies,
                                "cp-buy-product-before-booking-fb-session-id": key
                            },
                            validateStatus: status => status < 600
                        });

                        counterMap.set(key, (counterMap.get(key) || 0) + 1);

                        if (response) {
                            switch (response.status) {
                                case 200:
                                    logger.info(`✅ Booking Success, SessionId: ${key}`);
                                    isCompleted = true;
                                    break;
                                case 499:
                                    logger.info(`Slot not ready, SessionId: ${key}, Trying ${counterMap.get(key)}`);
                                    if (counterMap.get(key) >= 5) {
                                        detailMap.delete(key);
                                        logger.info(`Removed session with status 499: ${key}`);
                                    }
                                    break;
                                case 500:
                                case 502:
                                case 503:
                                    logger.info(`Server Error ${response.status}, SessionId: ${key}, Trying ${counterMap.get(key)}`);
                                    if (counterMap.get(key) >= 15) {
                                        detailMap.delete(key);
                                        logger.info(`Removed session with status 5xx: ${key}`);
                                    }
                                    break;
                                default:
                                    logger.info(`Unknown Status: ${response.status}, SessionId: ${key}`);
                                    break;
                            }
                        }
                    } catch (err) {
                        logger.error(`Unknown Exception, BookSlot fail, Error: ${err}, SessionId: ${key}`);
                    }
                })()
            );
        }

        // 并发执行所有请求
        await Promise.allSettled(bookingPromises);
        // === 👆 并行调用结束 ===

        if (isCompleted) break;

        await delay(1000); // 一轮结束后等1s再重试
    }

    // 清除购物车检查的定时器
    if (cartCheckInterval) {
        clearInterval(cartCheckInterval);
        cartCheckInterval = null;
    }

    logger.info(`Exising, ${isCompleted ? "Booking Success!" : "Booking Fail!"}`)
    if (isCompleted && emailToPhone.has(req.body.email)) {
        await makeCall(req.body.email)
    }
    if (res && isCompleted) {
        return res.status(200).json(`Booking Success, Please proceed to payment.`);
    } else if (res) {
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

async function makeCall(email) {
    try {
        logger.info(`Email: ${email}`);
        const call = await client.calls.create({
            to: emailToPhone.get(email),             // 目标号码
            from: "+17272611807",          // 你在 Twilio 购买的号码
            url: "https://booker.playunitedsg.com/voice" // TwiML，定义电话内容
        });
        logger.info(`Call initiated, SID: ${call.sid}`);
    } catch (err) {
        logger.info(`Error making call, err: ${err}`);
    }
}


module.exports = router;
