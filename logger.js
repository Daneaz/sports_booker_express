/**
 * logger Service
 */
const {createLogger, transports, format} = require('winston');


let logger = createLogger({
    format: format.combine(
        format.timestamp({format: 'YYYY-MM-DD HH:mm:ss:ms'}),
        format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`)
    ),
    transports: [
        new transports.Console()
    ]
});


if (process.env.LogFolder) {
    require('winston-daily-rotate-file');
    let transportDailyRotateFile = new (transports.DailyRotateFile)({
        filename: `${process.env.LogFolder}/%DATE%.log`,
        datePattern: 'YYYY-MM-DD',
        zippedArchive: true,
        // maxSize: '20m',
        // maxFiles: '14d'
    });
    transportDailyRotateFile.on('rotate', function (oldFilename, newFilename) {
    });

    logger.add(transportDailyRotateFile);
}
module.exports = logger;