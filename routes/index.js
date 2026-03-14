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
emailToPhone.set("naruto921210@gmail.com", "+6596559316");
axios.defaults.withCredentials = true;
axios.defaults.timeout = 10000; // 设置全局默认超时时间为 10 秒

// === HTTP Request Logging Interceptors ===
axios.interceptors.request.use(
    (config) => {
        logger.info(`[HTTP Request] ${config.method.toUpperCase()} ${config.url}`);
        if (config.data) {
            logger.info(`[HTTP Request Body] ${JSON.stringify(config.data)}`);
        }
        return config;
    },
    (error) => {
        logger.error(`[HTTP Request Error] ${error.message}`);
        return Promise.reject(error);
    }
);

axios.interceptors.response.use(
    (response) => {
        logger.info(`[HTTP Response] ${response.config.method.toUpperCase()} ${response.config.url} - Status: ${response.status}`);
        // 可选：记录响应体内容，但可能会很长，这里选择不记录
        return response;
    },
    (error) => {
        if (error.response) {
            logger.error(`[HTTP Response Error] ${error.config.method.toUpperCase()} ${error.config.url} - Status: ${error.response.status}`);
            logger.error(`[HTTP Error Detail] ${JSON.stringify(error.response.data)}`);
        } else {
            logger.error(`[HTTP Connection Error] ${error.message}`);
        }
        return Promise.reject(error);
    }
);
// =========================================

// === Time Sync Logic ===
let timeOffset = 0;

async function syncTime() {
    try {
        const startLocal = Date.now();
        // 使用 HEAD 请求获取服务器时间，减少数据传输
        const response = await axios.head("https://thekallang.perfectgym.com/clientportal2/", {
            timeout: 5000,
            // 确保不被拦截器记录过多日志（可选，取决于拦截器实现）
        });
        const endLocal = Date.now();
        const serverDateStr = response.headers.date; // e.g., "Wed, 21 Oct 2015 07:28:00 GMT"
        
        if (serverDateStr) {
            const serverTime = new Date(serverDateStr).getTime();
            // 估计往返时间 (RTT)
            const rtt = endLocal - startLocal;
            // 假设服务器时间是在 RTT 中点生成的
            const adjustedServerTime = serverTime + (rtt / 2);
            timeOffset = adjustedServerTime - endLocal;
            
            logger.info(`[Time Sync] Server Time: ${new Date(serverTime).toISOString()}, Local Time: ${new Date(endLocal).toISOString()}, Offset: ${timeOffset}ms, RTT: ${rtt}ms`);
        }
    } catch (err) {
        logger.error(`[Time Sync] Failed to sync time: ${err.message}`);
    }
}

// 每 15 分钟自动同步一次，防止时钟漂移
setInterval(syncTime, 15 * 60 * 1000);
// 立即进行首次同步
syncTime();

function getSyncMoment() {
    return moment().add(timeOffset, 'milliseconds');
}

function getSyncNow() {
    return Date.now() + timeOffset;
}
// =========================

// static content
const LOGIN_API = "https://thekallang.perfectgym.com/clientportal2/Auth/Login"
const QUERY_DETAIL_API = "https://thekallang.perfectgym.com/clientportal2/FacilityBookings/WizardSteps/SetFacilityBookingDetailsWizardStep/Next";
const BOOKING_API = "https://thekallang.perfectgym.com/clientportal2/FacilityBookings/WizardSteps/ChooseBookingRuleStep/Next"

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
        // cal for holding time, 使用同步后的时间
        let holdingTime = bookingTime.valueOf() - getSyncNow()
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
        const GET_SESSION_API = `https://thekallang.perfectgym.com/clientportal2/FacilityBookings/BuyProductBeforeBookingFacility/Start?RedirectUrl=https:%2F%2Fthekallang.perfectgym.com%2Fclientportal2%2F%23%2FFacilityBooking%3FclubId%3D1%26zoneTypeId%3D${req.body.type.value}%26date%3D${requestDate}&clubId=1&startDate=${requestDateTime}&zoneTypeId=${req.body.type.value}`
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
        const GET_SESSION_API = `https://thekallang.perfectgym.com/clientportal2/FacilityBookings/BuyProductBeforeBookingFacility/Start?RedirectUrl=https:%2F%2Fthekallang.perfectgym.com%2Fclientportal2%2F%23%2FFacilityBooking%3FclubId%3D1%26zoneTypeId%3D${req.body.type.value}%26date%3D${requestDate}&clubId=1&startDate=${requestDateTime}&zoneTypeId=${req.body.type.value}`
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
    const startTime = getSyncNow();
    const expiredTime = getSyncMoment().add(35, 'minutes');
    let isCompleted = false;
    let cartCheckInterval = null;

    // --- Worker Pool & Session Logic ---
    const activeWorkers = new Set();
    const processedSessions = new Set();

    // 获取当前阶段的延迟时间
    const getPhaseDelay = () => {
        const elapsed = getSyncNow() - startTime;
        if (elapsed < 5000) return 0;       // 冲刺期: 0ms
        if (elapsed < 60000) return 100;    // 稳定期: 100ms
        return 500;                         // 捡漏期: 500ms
    };

    // 启动一个预订 Worker
    const startWorker = async (detail) => {
        if (processedSessions.has(detail.sessionId)) return;
        processedSessions.add(detail.sessionId);
        activeWorkers.add(detail.sessionId);

        let retryCount = 0;
        logger.info(`[Worker Start] SessionId: ${detail.sessionId}`);

        while (!isCompleted && getSyncNow() < expiredTime.valueOf()) {
            retryCount++;
            const data = {
                "ruleId": detail.ruleId,
                "OtherCalendarEventBookedAtRequestedTime": false,
                "HasUserRequiredProducts": false,
                "ShouldBuyRequiredProductOnDebit": true
            };

            try {
                const response = await axios.post(BOOKING_API, data, {
                    timeout: 3000,
                    headers: {
                        "cookie": detail.cookies,
                        "cp-buy-product-before-booking-fb-session-id": detail.sessionId
                    },
                    validateStatus: status => status < 600
                });

                if (response.status === 200) {
                    logger.info(`✅ [Worker Success] SessionId: ${detail.sessionId}`);
                    isCompleted = true;
                    // 成功后立即触发一次购物车检查
                    await checkShoppingCart();
                    break;
                } else if (response.status === 499) {
                    // 还没放场，高频重试
                    const delayMs = getPhaseDelay();
                    if (delayMs > 0) await delay(delayMs);
                } else if (response.status >= 500) {
                    logger.warn(`[Worker Server Error] ${response.status}, SessionId: ${detail.sessionId}, Retry: ${retryCount}`);
                    await delay(500); // 服务器出错，稍等
                } else {
                    logger.info(`[Worker Status] ${response.status}, SessionId: ${detail.sessionId}, Retry: ${retryCount}`);
                    if (retryCount >= 200) break; // 单个 Session 尝试太多次，放弃
                    await delay(getPhaseDelay() || 100);
                }
            } catch (err) {
                logger.error(`[Worker Exception] ${err.message}, SessionId: ${detail.sessionId}`);
                await delay(1000);
            }
        }
        activeWorkers.delete(detail.sessionId);
        logger.info(`[Worker End] SessionId: ${detail.sessionId}, Total Retries: ${retryCount}`);
    };

    // 购物车检查逻辑
    const checkShoppingCart = async () => {
        try {
            const cartResponse = await axios.get('https://thekallang.perfectgym.com/clientportal2/Shopping/ShoppingCart/GetShoppingCartSummary', {
                headers: { "cookie": detailList[0].cookies },
                timeout: 2000,
                validateStatus: status => status < 600
            });

            if (cartResponse.status === 200 && cartResponse.data) {
                logger.info(`[Cart Check] TotalQuantity: ${cartResponse.data.TotalQuantity}, Gross: ${cartResponse.data.TotalAmount.Gross}`);
                if (cartResponse.data.TotalQuantity > 0 && cartResponse.data.TotalAmount.Gross > 0) {
                    isCompleted = true;
                    return true;
                }
            }
        } catch (err) {
            logger.error(`[Cart Check Error] ${err.message}`);
        }
        return false;
    };

    // 启动初始 Workers
    detailList.forEach(detail => startWorker(detail));

    // 定时刷新 Session 的保底逻辑 (每 30 秒)
    const refreshInterval = setInterval(async () => {
        if (isCompleted || getSyncNow() >= expiredTime.valueOf()) {
            clearInterval(refreshInterval);
            return;
        }

        if (activeWorkers.size < 3) { // 如果活跃 Worker 过少，刷新 Session
            logger.info(`[Session Manager] Low workers (${activeWorkers.size}), refreshing...`);
            const newZoneIds = await getAvailableSlot(req, res, cookies, userId, requestDate, requestDateTime);
            if (newZoneIds && newZoneIds.length > 0) {
                const newDetails = await fillUpDetail(req, res, cookies, userId, newZoneIds, requestDate, requestDateTime);
                if (newDetails) newDetails.forEach(d => startWorker(d));
            }
        }
    }, 30000);

    // 每 10 秒保底检查一次购物车
    cartCheckInterval = setInterval(checkShoppingCart, 10000);

    // 等待所有 Worker 结束或成功标记
    while (!isCompleted && activeWorkers.size > 0 && getSyncNow() < expiredTime.valueOf()) {
        await delay(1000);
    }

    // 清理资源
    clearInterval(refreshInterval);
    if (cartCheckInterval) clearInterval(cartCheckInterval);

    logger.info(`Exiting, ${isCompleted ? "Booking Success!" : "Booking Fail!"}`);
    if (isCompleted && emailToPhone.has(req.body.email)) {
        await makeCall(req.body.email);
    }

    if (res) {
        if (isCompleted) {
            return res.status(200).json(`Booking Success, Please proceed to payment.`);
        } else {
            return res.status(400).json(`Booking Fail, No slots available`);
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
