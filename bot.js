// ============================================================================
// GLOBAL ERROR HANDLERS - Prevent bot crashes from unhandled errors
// ============================================================================
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION:', reason);
    console.error('Promise:', promise);
    // Log to file if logger is available
    if (global.botLogger) {
        global.botLogger.error('❌ Unhandled Rejection', { reason, promise }, 'system');
    }
    // Don't exit - keep bot running
});

process.on('uncaughtException', (error, origin) => {
    console.error('❌ UNCAUGHT EXCEPTION:', error);
    console.error('Origin:', origin);
    console.error('Stack:', error.stack);
    // Log to file if logger is available
    if (global.botLogger) {
        global.botLogger.error('❌ Uncaught Exception', { error, origin, stack: error.stack }, 'system');
    }
    // Don't exit - keep bot running (unless it's a critical error)
    if (error.code === 'ERR_CRITICAL') {
        process.exit(1);
    }
});

console.log('✅ Global error handlers initialized');

// ============================================================================
// MODULE IMPORTS
// ============================================================================
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const moment = require('moment');
require('moment-timezone');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const Database = require('./database.js');
const ConfigManager = require('./utils/ConfigManager.js');
const AdvancedLogger = require('./utils/AdvancedLogger.js');
const RateLimiter = require('./utils/RateLimiter.js');
const DataManager = require('./utils/DataManager.js');
const BackupManager = require('./utils/BackupManager.js');
const SLAManager = require('./utils/SLAManager.js');
const LanguageManager = require('./utils/LanguageManager.js');
const phoneNormalizer = require('./utils/PhoneNormalizer.js');

// Baku vaxt zonası üçün konfiqurasiya
moment.locale('az');

class ADNSUITBot {
    constructor() {
        this.configManager = new ConfigManager();
        this.logger = new AdvancedLogger();
        this.db = new Database('tickets.db');

        // Make logger globally available for error handlers
        global.botLogger = this.logger;

        this.logger.info('🚀 ADNSU IT Bot başladılır...', null, 'system');

        this.client = new Client({
            authStrategy: new LocalAuth(),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        // The 'this.db' object is now the Database class instance.
        // The old in-memory structure is obsolete and removed.

        this.userStates = new Map();
        // ADMIN LOGIN STATE & SESSION
        this.adminLoginState = new Map();
        this.adminSessions = new Set();
        this.failedLoginAttempts = new Map(); // Track failed login attempts per phone (normalized)


        // Initialize DataManager
        this.dataManager = new DataManager();


        this.rateLimiter = new RateLimiter(this.configManager.get());
        this.performanceStats = {
            totalMessages: 0,
            slowOperations: 0,
            averageResponseTime: 0
        };

        this.reminderInterval = null;

        this.problemTypesExtended = {
            '1': '💻 Kompüter işləmir',
            '2': '🖥️ Monitor yanmır',
            '3': '🧾 Printer işləmir',
            '4': '📡 İnternet problemi',
            '5': '💡 Projectorun lampası yanıb',
            '6': 'Kompyuter və ya Sistem bloku yoxdur',
            '7': '⌨️ Klaviatura/Siçan işləmir',
            '8': '🔒 Proqram işləmir',
            '9': '📶 Wi-Fi problemi',
            '10': '💾 Format lazımdı',
            '11': '⚡ Enerji problemi',
            '12': '🌐 Veb səhifə açılmır',
            '13': '🔊 Səs sistemi işləmir',
            '14': 'Projektor yoxdu',
            '15': '⚙️ Digər',
            '16': '✍️ Özüm yazacağam'
        };

        // Initialize BackupManager
        this.backupManager = new BackupManager(
            this.configManager.get('backup') || {},
            this.logger
        );

        // Initialize SLAManager
        this.slaManager = new SLAManager(
            this.configManager.get('sla') || {},
            this.db,
            this.logger
        );

        // Initialize LanguageManager
        this.lang = new LanguageManager(this.db, './locales');

        this.setupDirectories();
        this.setupEventHandlers();
        this.loadDatabase();
        this.startReminderSystem();
        this.startAdvancedSystems();
    }

    /**
     * Start backup and SLA monitoring systems
     */
    startAdvancedSystems() {
        // Start backup system
        this.backupManager.start();

        // Start SLA monitoring with alert callback
        this.slaManager.start(async (alertMessage) => {
            const groupId = this.configManager.get('traineeGroupId');
            if (groupId) {
                await this.client.sendMessage(groupId, alertMessage);
            }
        });
    }

    setupDirectories() {
        const directories = [
            './longphoto',
            './logs/info',
            './logs/warn',
            './logs/error',
            './logs/debug',
            './logs/performance',
            './logs/tickets',
            './logs/commands',
            './logs/photos',
            './logs/security'
        ];

        directories.forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
                this.logger.info(`📁 Qovluq yaradıldı: ${dir}`, null, 'system');
            }
        });
    }

    setupEventHandlers() {
        // Wrap all event handlers with try/catch to prevent crashes
        this.client.on('qr', async (qr) => {
            try {
                await this.handleQr(qr);
            } catch (error) {
                this.logger.error('❌ QR handler error:', error, 'system');
            }
        });

        this.client.on('ready', async () => {
            try {
                await this.handleReady();
            } catch (error) {
                this.logger.error('❌ Ready handler error:', error, 'system');
            }
        });

        this.client.on('message', async (message) => {
            try {
                await this.handleMessage(message);
            } catch (error) {
                this.logger.error('❌ Message handler error:', error, 'system');
                // Try to notify user about the error
                try {
                    await message.reply('❌ Xəta baş verdi. Zəhmət olmasa bir daha cəhd edin.');
                } catch (replyError) {
                    this.logger.error('❌ Could not send error reply:', replyError, 'system');
                }
            }
        });

        this.client.on('group_join', async (notification) => {
            try {
                await this.handleGroupJoin(notification);
            } catch (error) {
                this.logger.error('❌ Group join handler error:', error, 'system');
            }
        });

        // ============================================================================
        // CONNECTION RECOVERY HANDLERS
        // ============================================================================
        this.client.on('auth_failure', (msg) => {
            this.logger.error('❌ Authentication failure:', msg, 'system');
            console.error('❌ AUTHENTICATION FAILURE:', msg);
            console.log('💡 Həll: .wwebjs_auth qovluğunu silin və yenidən QR kod skan edin');
        });

        this.client.on('disconnected', (reason) => {
            this.logger.error('❌ WhatsApp disconnected:', reason, 'system');
            console.error('❌ WHATSAPP DISCONNECTED:', reason);
            console.log('🔄 Yenidən bağlanmağa cəhd edilir...');

            // Try to reconnect after 5 seconds
            setTimeout(() => {
                try {
                    this.logger.info('🔄 Reconnecting...', null, 'system');
                    this.client.initialize();
                } catch (error) {
                    this.logger.error('❌ Reconnection failed:', error, 'system');
                }
            }, 5000);
        });

        this.client.on('loading_screen', (percent, message) => {
            this.logger.debug(`⏳ Loading: ${percent}% - ${message}`, null, 'system');
        });

        this.logger.info('✅ Event handlers configured with error protection', null, 'system');
    }

    // normalizePhone - delegates to centralized PhoneNormalizer utility
    normalizePhone(input) {
        return phoneNormalizer.normalize(input);
    }

    // ============================================================================
    // COMMAND VALIDATION HELPER - Prevent crashes from malformed commands
    // ============================================================================
    validateCommandArgs(message, commandName, minArgs, usage) {
        if (!message || !message.body) {
            return { valid: false, error: '❌ Invalid message' };
        }

        const parts = message.body.trim().split(/\s+/);

        if (parts.length < minArgs + 1) { // +1 for command itself
            return {
                valid: false,
                error: `❌ Yanlış istifadə!\n\n📝 Düzgün format:\n${usage}`
            };
        }

        return { valid: true, parts };
    }

    handleQr(qr) {
        this.logger.info('📱 QR kodu yaradıldı', null, 'system');
        console.log('📱 QR kodu skan edin:');
        qrcode.generate(qr, { small: true });
    }

    async handleReady() {
        this.logger.info('✅ ADNSU IT Bot aktiv!', null, 'system');
        console.log('✅ ADNSU IT Bot aktiv!');

        const logStats = await this.logger.getLogStats();
        this.logger.info('📊 Log statistikaları:', logStats, 'system');
    }

    handleGroupJoin(notification) {
        this.logger.info('🔔 Bot qrupa əlavə edildi:', { chatId: notification.chatId }, 'system');
    }

    /**
     * Check if current time is within working hours
     * Working hours: Monday-Friday, 8:00 AM - 10:00 PM (Baku time)
     * @returns {boolean}
     */
    isWorkingHours() {
        const now = this.getBakuTime();
        const dayOfWeek = now.day(); // 0 = Sunday, 6 = Saturday
        const hour = now.hour();

        // Check if weekend (Saturday = 6, Sunday = 0)
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            return false;
        }

        // Check if within working hours (8:00 - 22:00)
        if (hour < 8 || hour >= 22) {
            return false;
        }

        return true;
    }

    //  AVTOMATİK XATIRLATMA SİSTEMİ
    startReminderSystem() {
        const interval = this.configManager.get('reminderInterval') * 60 * 1000;
        this.reminderInterval = setInterval(() => {
            this.sendReminder();
        }, interval);

        this.logger.info(`⏰ Avtomatik xatırlatma sistemi başladıldı (${this.configManager.get('reminderInterval')} dəqiqə, iş saatları: 08:00-22:00, iş günləri)`, null, 'system');
    }

    async sendReminder() {
        try {
            // Only send automatic reminders during working hours (weekdays 8AM-10PM)
            if (!this.isWorkingHours()) {
                this.logger.debug('⏰ İş saatlarından kənarda - xatırlatma göndərilmir', null, 'system');
                return;
            }

            const openTickets = await this.db.all("SELECT * FROM tickets WHERE status = 'open' ORDER BY id ASC");

            if (openTickets.length === 0) {
                return;
            }

            let reminderMessage = `⏰ AÇIQ TICKET XATIRLATMA - ${this.getBakuTime().format('DD.MM.YYYY HH:mm')}\n\n`;
            reminderMessage += `📋 Cari Açıq Ticketlar:\n\n`;

            openTickets.forEach((ticket, index) => {
                const openDuration = this.calculateOpenDuration(ticket.created_at);
                const createdTime = moment(ticket.created_at).format('DD.MM.YYYY HH:mm');

                reminderMessage += `#${ticket.id} - K${ticket.corpus}-${ticket.room}\n`;
                reminderMessage += `🔧 Problem: ${ticket.problem_type}\n`;
                reminderMessage += `👤 İstifadəçi: ${ticket.username}\n`;
                reminderMessage += `⏰ Açıq vaxt: ${openDuration}\n`;
                reminderMessage += `🕐 Yaradılma: ${createdTime}\n\n`;
            });

            reminderMessage += `Ümumi: ${openTickets.length} açıq ticket`;

            const groupId = this.configManager.get('traineeGroupId');
            if (groupId) {
                await this.client.sendMessage(groupId, reminderMessage);
                this.logger.info('⏰ Xatırlatma göndərildi', { ticketCount: openTickets.length }, 'tickets');
            }

        } catch (error) {
            this.logger.error('❌ Xatırlatma göndərmə xətası:', error, 'system');
        }
    }

    calculateOpenDuration(createdAt) {
        const created = moment(createdAt);
        const now = this.getBakuTime();
        const duration = moment.duration(now.diff(created));

        const hours = Math.floor(duration.asHours());
        const minutes = duration.minutes();

        if (hours > 0) {
            return `${hours} saat ${minutes} dəqiqə`;
        } else {
            return `${minutes} dəqiqə`;
        }
    }

    calculateSolveDuration(createdAt, solvedAt) {
        const created = moment(createdAt);
        const solved = moment(solvedAt);
        const duration = moment.duration(solved.diff(created));

        const hours = Math.floor(duration.asHours());
        const minutes = duration.minutes();

        if (hours > 0) {
            return `${hours} saat ${minutes} dəqiqə`;
        } else {
            return `${minutes} dəqiqə`;
        }
    }

    // PERFORMANS İZLƏMƏ
    async withPerformanceMonitoring(operationName, asyncFunction) {
        const startTime = Date.now();

        try {
            const result = await asyncFunction();
            const duration = Date.now() - startTime;

            this.performanceStats.totalMessages++;
            this.performanceStats.averageResponseTime =
                (this.performanceStats.averageResponseTime * (this.performanceStats.totalMessages - 1) + duration) /
                this.performanceStats.totalMessages;

            if (duration > 2000) {
                this.performanceStats.slowOperations++;
                this.logger.warn(`⚠️ ${operationName} ${duration}ms çəkdi (2s limiti aşıb)`, { duration }, 'performance');
            }

            this.logger.performance(`${operationName} tamamlandı`, {
                duration: duration,
                averageResponseTime: this.performanceStats.averageResponseTime,
                totalMessages: this.performanceStats.totalMessages
            });

            return result;
        } catch (error) {
            const duration = Date.now() - startTime;
            this.logger.error(`❌ ${operationName} xətası (${duration}ms):`, error, 'performance');
            throw error;
        }
    }

    // VERİLƏNLƏR BAZASI
    async loadDatabase() {
        return this.withPerformanceMonitoring('loadDatabase', async () => {
            try {
                await this.db.init();
                this.logger.info('✅ Verilənlər bazası uğurla başladıldı.', null, 'system');

                // MIGRATION: Banned users from DB to bannedusers.json
                try {
                    const dbBanned = await this.db.all('SELECT user_id FROM banned_users');
                    if (dbBanned && dbBanned.length > 0) {
                        let migratedCount = 0;
                        dbBanned.forEach(row => {
                            const normalized = this.normalizePhone(row.user_id) || row.user_id;
                            if (this.dataManager.banUser(normalized)) {
                                migratedCount++;
                            }
                        });
                        if (migratedCount > 0) {
                            this.logger.info(`🔄 ${migratedCount} banlı istifadəçi DB-dən bannedusers.json-a miqrasiya edildi`, null, 'system');
                        }
                    }
                } catch (migrationError) {
                    // Ignore error if table doesn't exist (e.g. fresh install or already removed)
                    this.logger.info('ℹ️ Banned users migration skipped (table missing or error)', null, 'system');
                }

                // Start realtime dashboard server if available
                try {
                    const dashboard = require('./dashboard_server.js');
                    const port = this.configManager.get('dashboardPort') || 3000;
                    dashboard.start(this.db, port);
                    this.logger.info(`🔗 Dashboard server started on http://localhost:${port}/tickets.html`, null, 'system');
                } catch (dsErr) {
                    this.logger.warn('⚠️ Dashboard server failed to start or is not available:', dsErr);
                }

            } catch (error) {
                this.logger.error('❌ Verilənlər bazası başlama xətası:', error, 'system');
                // Critical error, stop the bot
                process.exit(1);
            }
        });
    }

    // saveDatabase method removed as it is now obsolete with SQLite.
    async handleExport(message) {
        try {
            const { MessageMedia } = require('whatsapp-web.js');
            const ExcelJS = require('exceljs');
            const PDFDocument = require('pdfkit');
            const fs = require('fs');
            const tickets = await this.db.all('SELECT * FROM tickets ORDER BY id ASC');

            // ===============================
            // 📊 1) STATISTIKA HAZIRLANMASI
            // ===============================

            const total = tickets.length;
            const open = tickets.filter(t => t.status === 'open');
            const solved = tickets.filter(t => t.status === 'solved');
            const longTerm = tickets.filter(t => t.status === 'long_term');

            // Ən köhnə açıq bilet
            let oldestOpen = null;
            if (open.length > 0) {
                oldestOpen = open.reduce((a, b) =>
                    moment(a.created_at).isBefore(moment(b.created_at)) ? a : b
                );
            }

            // Orta həll müddəti
            let avgSolve = 'Yoxdur';
            const solvedDurations = solved
                .filter(t => t.solved_at)
                .map(t => moment(t.solved_at).diff(moment(t.created_at), 'minutes'));

            if (solvedDurations.length > 0) {
                const avgMin = Math.round(solvedDurations.reduce((a, b) => a + b, 0) / solvedDurations.length);
                avgSolve = avgMin < 60
                    ? `${avgMin} dəqiqə`
                    : `${Math.floor(avgMin / 60)} saat ${avgMin % 60} dəqiqə`;
            }

            // Admin statistika
            const adminCount = {};
            tickets.forEach(t => {
                // Use assigned_admin_name if available, otherwise just assigned_admin phone
                // Also can fallback to closed_by which might be same
                const adminIdentifier = t.assigned_admin_name || t.assigned_admin;
                if (adminIdentifier) {
                    adminCount[adminIdentifier] = (adminCount[adminIdentifier] || 0) + 1;
                }
            });


            // Bu gün statistika
            const today = moment().format("YYYY-MM-DD");
            const todayCreated = tickets.filter(t => t.created_at.startsWith(today)).length;
            const todaySolved = tickets.filter(t => t.solved_at && t.solved_at.startsWith(today)).length;

            // ===============================
            // 📘 2) EXCEL FAYLI YARADILMASI
            // ===============================

            const excel = new ExcelJS.Workbook();

            // --- SHEET 1: TICKET LIST ---
            const sheet1 = excel.addWorksheet('Tickets');

            sheet1.columns = [
                { header: 'ID', key: 'id', width: 10 },
                { header: 'Opened By', key: 'opened_by', width: 20 },
                { header: 'Phone', key: 'phone', width: 20 },
                { header: 'Closed By', key: 'closed_by', width: 20 },
                { header: 'Corpus', key: 'corpus', width: 10 },
                { header: 'Room', key: 'room', width: 10 },
                { header: 'Problem', key: 'problem', width: 35 },
                { header: 'Solution', key: 'solution', width: 35 },
                { header: 'Status', key: 'status', width: 12 },
                { header: 'Created', key: 'created', width: 20 },
                { header: 'Solved', key: 'solved', width: 20 },
                { header: 'Solve Duration', key: 'duration', width: 18 }
            ];

            tickets.forEach(t => {
                let duration = '';
                if (t.solved_at) {
                    const min = moment(t.solved_at).diff(moment(t.created_at), 'minutes');
                    duration = min < 60 ? `${min} dəqiqə` : `${Math.floor(min / 60)} saat ${min % 60} dəqiqə`;
                }

                sheet1.addRow({
                    id: t.id,
                    opened_by: t.username,
                    phone: t.phone || this.formatPhoneNumber(t.user_id || t.user),
                    closed_by: t.assigned_admin_name || t.assigned_admin || '',

                    corpus: t.corpus,
                    room: t.room,
                    problem: t.problem_type,
                    solution: t.solution || '',
                    status: t.status,
                    created: t.created_at,
                    solved: t.solved_at || '',
                    duration: duration
                });
            });

            // --- SHEET 2: STATISTIKA ---
            const sheet2 = excel.addWorksheet('Statistika');

            sheet2.addRow(["STATISTIKA"]).font = { bold: true, size: 16 };
            sheet2.addRow([]);

            sheet2.addRow(["Ümumi Ticket", total]);
            sheet2.addRow(["Açıq Ticket", open.length]);
            sheet2.addRow(["Uzunmüddətli", longTerm.length]);
            sheet2.addRow(["Həll Edilmiş", solved.length]);
            sheet2.addRow(["Orta həll müddəti", avgSolve]);

            if (oldestOpen)
                sheet2.addRow(["Ən köhnə açıq ticket", `#${oldestOpen.id} – ${moment(oldestOpen.created_at).fromNow()} əvvəl`]);

            sheet2.addRow([]);
            sheet2.addRow(["ADMIN STATISTIKASI"]).font = { bold: true, size: 14 };

            for (const [admin, count] of Object.entries(adminCount)) {
                sheet2.addRow([admin, count]);
            }

            sheet2.addRow([]);
            sheet2.addRow(["BU GÜN"]);
            sheet2.addRow(["Bu gün açılan", todayCreated]);
            sheet2.addRow(["Bu gün həll edilən", todaySolved]);

            const excelPath = './export.xlsx';
            await excel.xlsx.writeFile(excelPath);

            // ===============================
            // 📄 3) PDF FAYLI YARADILMASI
            // ===============================

            const pdfPath = './export.pdf';
            await new Promise((resolve, reject) => {
                const pdf = new PDFDocument({ margin: 30 });
                const stream = fs.createWriteStream(pdfPath);

                // ✅ Add error handlers to prevent crashes
                stream.on('error', (err) => {
                    this.logger.error('❌ PDF stream error:', err, 'commands');
                    reject(err);
                });

                pdf.on('error', (err) => {
                    this.logger.error('❌ PDF document error:', err, 'commands');
                    reject(err);
                });

                pdf.pipe(stream);

                pdf.fontSize(20).text('ADNSU IT Export', { align: 'center' });
                pdf.moveDown();

                // STATISTIKA PDF
                pdf.fontSize(14).text("📊 STATİSTİKA");
                pdf.fontSize(11).text(`Ümumi ticket: ${total}`);
                pdf.text(`Açıq ticket: ${open.length}`);
                pdf.text(`Uzunmüddətli: ${longTerm.length}`);
                pdf.text(`Həll edilən: ${solved.length}`);
                pdf.text(`Orta həll müddəti: ${avgSolve}`);

                if (oldestOpen)
                    pdf.text(`Ən köhnə açıq ticket: #${oldestOpen.id} (${moment(oldestOpen.created_at).fromNow()} əvvəl)`);

                pdf.moveDown();

                pdf.fontSize(14).text("👨‍💻 Admin statistikası");
                pdf.fontSize(11);
                for (const [admin, count] of Object.entries(adminCount)) {
                    pdf.text(`${admin}: ${count} ticket`);
                }

                pdf.moveDown();
                pdf.fontSize(14).text("📅 Bu gün");
                pdf.fontSize(11).text(`Bu gün açılan: ${todayCreated}`);
                pdf.text(`Bu gün həll edilən: ${todaySolved}`);

                pdf.moveDown(2);

                // TICKET LİST PDF
                pdf.fontSize(16).text("🎫 Ticket List");
                pdf.moveDown();

                tickets.forEach(t => {
                    pdf.fontSize(11).text(
                        `#${t.id} | ${t.username} | ${t.phone || this.formatPhoneNumber(t.user_id || t.user)} | K${t.corpus}-${t.room}\n` +
                        `Problem: ${t.problem_type}\n` +
                        (t.solution ? `Solution: ${t.solution}\n` : '') +
                        `Created: ${t.created_at}\n` +
                        `Solved: ${t.solved_at || '---'}\n`
                    );
                    pdf.moveDown();
                });

                pdf.end();
                stream.on('finish', resolve);
                stream.on('error', reject);
            });

            // ===============================
            // 📤 4) FAYLLARIN GÖNDƏRİLMƏSİ
            // ===============================

            await this.sendQuickReply(message, "📤 Export hazırdır! Fayllar göndərilir...");
            await this.client.sendMessage(message.from, MessageMedia.fromFilePath(excelPath));
            await this.client.sendMessage(message.from, MessageMedia.fromFilePath(pdfPath));

            this.logger.info('📤 Export göndərildi', { to: message.from }, 'commands');

        } catch (err) {
            this.logger.error('❌ Export xətası:', err, 'commands');
            await this.sendQuickReply(message, '❌ Export zamanı xəta baş verdi');
        }
    }
    async handleLogExport(message) {
        try {
            const fs = require('fs');
            const path = require('path');
            const archiver = require('archiver');
            const { MessageMedia } = require('whatsapp-web.js');

            const logFolder = './logs';
            const outputFile = `./logs_export_${moment().format('YYYY-MM-DD_HH-mm-ss')}.zip`;

            const output = fs.createWriteStream(outputFile);
            const archive = archiver('zip', { zlib: { level: 9 } });

            // ✅ Add error handlers to prevent crashes
            output.on('error', (err) => {
                this.logger.error('❌ Stream error in log export:', err, 'commands');
                throw err;
            });

            archive.on('error', (err) => {
                this.logger.error('❌ Archive error in log export:', err, 'commands');
                throw err;
            });

            archive.pipe(output);
            archive.directory(logFolder, false);
            await archive.finalize();

            await new Promise((resolve, reject) => {
                output.on('close', resolve);
                output.on('error', reject);
            });

            await this.sendQuickReply(message, "📦 Log faylları hazırlandı, göndərilir...");
            await this.client.sendMessage(message.from, MessageMedia.fromFilePath(outputFile));

            this.logger.info("📤 Logexport göndərildi", { file: outputFile }, "commands");

            // ✅ Clean up file after sending
            setTimeout(() => {
                if (fs.existsSync(outputFile)) {
                    fs.unlinkSync(outputFile);
                }
            }, 5000);

        } catch (err) {
            this.logger.error("❌ Logexport xətası:", err, "commands");
            await this.sendQuickReply(message, "❌ Logexport zamanı xəta baş verdi!");
        }
    }

    async handleDatabaseExport(message) {
        try {
            const fs = require('fs');
            const path = require('path');
            const archiver = require('archiver');
            const { MessageMedia } = require('whatsapp-web.js');

            const filesToZip = ['./tickets.db', 'tickets.db-wal', 'tickets.db-shm', 'database.js', './config.json', './admins.js', './bannedusers.json'];
            const missing = filesToZip.filter(f => !fs.existsSync(f));

            if (missing.length > 0) {
                await this.sendQuickReply(message, `❌ Aşağıdakı fayllar tapılmadı: ${missing.join(', ')}`);
                return;
            }

            const outputFile = `./database_export_${moment().format('YYYY-MM-DD_HH-mm-ss')}.zip`;
            const output = fs.createWriteStream(outputFile);
            const archive = archiver('zip', { zlib: { level: 9 } });

            // ✅ Add error handlers to prevent crashes
            output.on('error', (err) => {
                this.logger.error('❌ Stream error in database export:', err, 'commands');
                throw err;
            });

            archive.on('error', (err) => {
                this.logger.error('❌ Archive error in database export:', err, 'commands');
                throw err;
            });

            archive.pipe(output);
            filesToZip.forEach(f => archive.file(f, { name: path.basename(f) }));

            // ✅ Add longphoto directory if exists
            if (fs.existsSync('./longphoto')) {
                archive.directory('./longphoto', 'longphoto');
            }

            await archive.finalize();

            await new Promise((resolve, reject) => {
                output.on('close', resolve);
                output.on('error', reject);
            });

            await this.sendQuickReply(message, "📦 Database faylları hazırlandı, göndərilir...");
            await this.client.sendMessage(message.from, MessageMedia.fromFilePath(outputFile));

            this.logger.security('📤 Database export göndərildi', { file: outputFile }, 'security');

            // ✅ Clean up file after sending
            setTimeout(() => {
                if (fs.existsSync(outputFile)) {
                    fs.unlinkSync(outputFile);
                }
            }, 5000);

        } catch (err) {
            this.logger.error('❌ Database export xətası:', err, 'commands');
            await this.sendQuickReply(message, '❌ Database export zamanı xəta baş verdi!');
        }
    }

    // SÜRƏTLİ CAVAB ÜSULU
    async sendQuickReply(message, text) {
        return this.withPerformanceMonitoring('sendQuickReply', async () => {
            try {
                await message.reply(text);
            } catch (error) {
                this.logger.error('❌ Mesaj göndərmə xətası:', error, 'system');
            }
        });
    }

    // ============================================================================
    // PHASE 3: ADVANCED FEATURES
    // ============================================================================

    /**
     * Handle /sla command - Show SLA status for open tickets
     */
    async handleSLA(message) {
        try {
            const report = await this.slaManager.getSLAReport();

            if (!report || report.total === 0) {
                await this.sendQuickReply(message, 'ℹ️ Hal-hazırda açıq ticket yoxdur.');
                return;
            }

            let slaMessage = `⏱️ SLA HESABATI\n\n`;
            slaMessage += `📊 Ümumi açıq: ${report.total}\n`;
            slaMessage += `🟢 Normal: ${report.ok.length}\n`;
            slaMessage += `🟡 Xəbərdarlıq (>${this.slaManager.config.warningHours}h): ${report.warning.length}\n`;
            slaMessage += `🔴 Kritik (>${this.slaManager.config.criticalHours}h): ${report.critical.length}\n\n`;
            slaMessage += `📈 Orta yaş: ${report.stats.avgAgeHours} saat\n`;
            slaMessage += `⏰ Ən köhnə: ${report.stats.oldestHours.toFixed(1)} saat\n\n`;

            if (report.critical.length > 0) {
                slaMessage += `🔴 KRİTİK TİCKETLAR:\n`;
                report.critical.slice(0, 5).forEach(v => {
                    slaMessage += `• #${v.ticket.id} - K${v.ticket.corpus}-${v.ticket.room} (${v.ageHours}h)\n`;
                });
                if (report.critical.length > 5) {
                    slaMessage += `... və ${report.critical.length - 5} daha çox\n`;
                }
            }

            await this.sendQuickReply(message, slaMessage);
            this.logger.info('⏱️ SLA hesabatı göstərildi', null, 'commands');

        } catch (error) {
            this.logger.error('❌ SLA xətası:', error, 'commands');
            await this.sendQuickReply(message, '❌ SLA hesabatı gətirilərkən xəta baş verdi!');
        }
    }

    /**
     * Handle /backup command - Create manual backup
     */
    async handleBackup(message) {
        try {
            await this.sendQuickReply(message, '💾 Backup yaradılır...');

            const backupPath = await this.backupManager.createBackup();
            const backups = this.backupManager.listBackups();

            let backupMessage = `✅ Backup uğurla yaradıldı!\n\n`;
            backupMessage += `📁 Son backuplar:\n`;
            backups.slice(0, 5).forEach((b, i) => {
                backupMessage += `${i + 1}. ${b.name} (${b.size})\n`;
            });

            await this.sendQuickReply(message, backupMessage);
            this.logger.info('💾 Manual backup yaradıldı', { path: backupPath }, 'commands');

        } catch (error) {
            this.logger.error('❌ Backup xətası:', error, 'commands');
            await this.sendQuickReply(message, '❌ Backup yaradılarkən xəta baş verdi!');
        }
    }

    /**
     * Handle /rate command - Rate a solved ticket
     */
    async handleRate(message) {
        const parts = message.body.split(' ');
        if (parts.length < 3) {
            await this.sendQuickReply(message, '❌ İstifadə: /rate <ticket_id> <1-5>');
            return;
        }

        const ticketId = parseInt(parts[1]);
        const rating = parseInt(parts[2]);

        if (isNaN(rating) || rating < 1 || rating > 5) {
            await this.sendQuickReply(message, '❌ Qiymət 1-5 aralığında olmalıdır!');
            return;
        }

        try {
            const ticket = await this.db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);

            if (!ticket) {
                await this.sendQuickReply(message, '❌ Ticket tapılmadı!');
                return;
            }

            if (ticket.status !== 'solved') {
                await this.sendQuickReply(message, '❌ Yalnız həll olunmuş ticketları qiymətləndirmək olar!');
                return;
            }

            const userPhone = this.normalizePhone(message.from);

            // Check if already rated
            const existingFeedback = await this.db.get('SELECT * FROM feedback WHERE ticket_id = ?', [ticketId]);
            if (existingFeedback) {
                await this.sendQuickReply(message, 'ℹ️ Bu ticket artıq qiymətləndirilib.');
                return;
            }

            await this.db.run(
                'INSERT INTO feedback (ticket_id, user_phone, rating) VALUES (?, ?, ?)',
                [ticketId, userPhone, rating]
            );

            const stars = '⭐'.repeat(rating);
            await this.sendQuickReply(message, `✅ Ticket #${ticketId} üçün qiymət: ${stars}\nTəşəkkür edirik!`);

            this.logger.info('⭐ Feedback alındı', { ticketId, rating, user: userPhone }, 'tickets');

        } catch (error) {
            this.logger.error('❌ Rate xətası:', error, 'commands');
            await this.sendQuickReply(message, '❌ Qiymətləndirmə zamanı xəta baş verdi!');
        }
    }

    /**
     * Handle /search command - Advanced ticket search
     */
    async handleSearch(message) {
        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /search <açar söz>');
            return;
        }

        const searchTerm = parts.slice(1).join(' ');

        try {
            const searchTermLike = `%${searchTerm.toLowerCase()}%`;
            const tickets = await this.db.all(
                `SELECT * FROM tickets WHERE 
                    LOWER(problem_type) LIKE ? OR 
                    LOWER(username) LIKE ? OR 
                    LOWER(room) LIKE ? OR
                    LOWER(corpus) LIKE ? OR
                    LOWER(solution) LIKE ? OR
                    id LIKE ?
                ORDER BY id DESC LIMIT 15`,
                [searchTermLike, searchTermLike, searchTermLike, searchTermLike, searchTermLike, searchTermLike]
            );

            if (tickets.length === 0) {
                await this.sendQuickReply(message, `🔍 "${searchTerm}" üçün nəticə tapılmadı.`);
                return;
            }

            let searchResults = `🔍 AXTARIŞ: "${searchTerm}" (${tickets.length})\n\n`;

            tickets.forEach((ticket, index) => {
                const status = ticket.status === 'solved' ? '✅' : (ticket.status === 'long_term' ? '⏳' : '🔴');
                searchResults += `${status} #${ticket.id} - K${ticket.corpus}-${ticket.room}\n`;
                searchResults += `   ${ticket.problem_type}\n`;
                if (ticket.solution) {
                    searchResults += `   💡 ${ticket.solution.substring(0, 30)}...\n`;
                }
                searchResults += `\n`;
            });

            await this.sendQuickReply(message, searchResults);
            this.logger.info('🔍 Axtarış edildi', { term: searchTerm, count: tickets.length }, 'commands');

        } catch (error) {
            this.logger.error('❌ Search xətası:', error, 'commands');
            await this.sendQuickReply(message, '❌ Axtarış zamanı xəta baş verdi!');
        }
    }

    /**
     * Handle /adminperformance command - Show admin metrics
     */
    async handleAdminPerformance(message) {
        try {
            // Get solved tickets with response times
            const metrics = await this.db.all(`
                SELECT 
                    assigned_admin_name,
                    assigned_admin,
                    COUNT(*) as solved_count,
                    AVG(CAST((julianday(solved_at) - julianday(created_at)) * 24 * 60 AS INTEGER)) as avg_minutes
                FROM tickets 
                WHERE status = 'solved' AND assigned_admin IS NOT NULL
                GROUP BY assigned_admin
                ORDER BY solved_count DESC
                LIMIT 10
            `);

            if (metrics.length === 0) {
                await this.sendQuickReply(message, 'ℹ️ Hələ admin performans datası yoxdur.');
                return;
            }

            // Get feedback averages
            const feedbackStats = await this.db.all(`
                SELECT 
                    t.assigned_admin_name,
                    AVG(f.rating) as avg_rating,
                    COUNT(f.id) as feedback_count
                FROM feedback f
                JOIN tickets t ON f.ticket_id = t.id
                GROUP BY t.assigned_admin
            `);

            let perfMessage = `📊 ADMİN PERFORMANSI\n\n`;

            metrics.forEach((m, i) => {
                const name = m.assigned_admin_name || m.assigned_admin || 'Naməlum';
                const avgTime = m.avg_minutes ? `${Math.round(m.avg_minutes)} dəq` : 'N/A';

                // Find feedback for this admin
                const fb = feedbackStats.find(f => f.assigned_admin_name === m.assigned_admin_name);
                const rating = fb ? `⭐${fb.avg_rating.toFixed(1)}` : '';

                perfMessage += `${i + 1}. ${name}\n`;
                perfMessage += `   ✅ ${m.solved_count} həll | ⏱️ ${avgTime} ${rating}\n\n`;
            });

            await this.sendQuickReply(message, perfMessage);
            this.logger.info('📊 Admin performans göstərildi', null, 'commands');

        } catch (error) {
            this.logger.error('❌ Admin performans xətası:', error, 'commands');
            await this.sendQuickReply(message, '❌ Performans statistikası gətirilərkən xəta baş verdi!');
        }
    }

    /**
     * Handle /lang command - Switch language
     */
    async handleLanguage(message) {
        const parts = message.body.split(' ');
        const userPhone = message.from;

        // If just /lang, show language selection
        if (parts.length < 2) {
            const currentLang = await this.lang.getUserLang(userPhone);
            const selectText = await this.lang.get(userPhone, 'lang_select');
            const currentText = await this.lang.get(userPhone, 'lang_current', {
                lang: this.lang.getLangName(currentLang)
            });
            await this.sendQuickReply(message, `${currentText}\n\n${selectText}`);
            return;
        }

        const newLang = parts[1].toLowerCase();

        if (!this.lang.supportedLangs.includes(newLang)) {
            const errorText = await this.lang.get(userPhone, 'lang_invalid');
            await this.sendQuickReply(message, errorText);
            return;
        }

        // Set new language
        await this.lang.setUserLang(userPhone, newLang);

        // Confirm in new language
        const confirmText = this.lang.translate(newLang, 'lang_changed');
        await this.sendQuickReply(message, confirmText);

        this.logger.info('🌐 Language changed', { user: userPhone, lang: newLang }, 'commands');
    }

    // MESAJ İŞLƏMƏ
    async handleMessage(message) {
        if (message.fromMe) return;
        const isGroup = message.from.endsWith('@g.us');

        // Use centralized PhoneNormalizer for consistent sender extraction
        const senderIdRaw = phoneNormalizer.extractSenderId(message, isGroup);
        const normalizedSender = phoneNormalizer.normalize(senderIdRaw);

        // ✅ Global ban check: if sender is banned, log their message and ignore
        if (normalizedSender && this.dataManager.isBanned(normalizedSender)) {
            // Log banned user's message to banned_messages.log
            try {
                const senderName = message._data.notifyName || 'Naməlum';
                const text = message.body || '';
                const timestamp = this.getBakuTime().format('YYYY-MM-DD HH:mm:ss');

                const bannedLogData = {
                    timestamp: timestamp,
                    phone: this.formatPhoneNumber(normalizedSender),
                    normalizedPhone: normalizedSender,
                    name: senderName,
                    message: text,
                    isGroup: isGroup,
                    from: message.from
                };

                // Write to banned_messages.log file
                const logLine = `[${timestamp}] 🚫 BANNED USER: ${this.formatPhoneNumber(normalizedSender)} (${senderName}) ${isGroup ? '[GROUP]' : '[PRIVATE]'}: ${text}\n`;
                const bannedLogPath = path.join(__dirname, 'logs', 'banned_messages.log');

                fs.appendFileSync(bannedLogPath, logLine, 'utf8');

                // Also log to system logger
                this.logger.security('🚫 Banlı istifadəçidən mesaj', bannedLogData, 'security');

                console.log(`[${timestamp}] 🚫 BANNED: ${this.formatPhoneNumber(normalizedSender)} (${senderName}): ${text}`);
            } catch (logError) {
                console.error('❌ Banlı istifadəçi mesajı loglama xətası:', logError);
            }

            // Silently ignore - no reply to banned user
            return;
        }

        // 🔒 HƏR GƏLƏN MESAJI LOGLAYIRIQ (TARİX + SAAT + NÖMRƏ + AD + MESAJ)
        // ✅ Only non-banned users reach this point
        try {
            const sender = message.from;
            const senderName = message._data.notifyName || 'Naməlum';
            const text = message.body || '';
            const timestamp = this.getBakuTime().format('YYYY-MM-DD HH:mm:ss');

            const logData = {
                phone: sender,
                formattedPhone: this.formatPhoneNumber(sender),
                name: senderName,
                message: text,
                time: timestamp,
                isGroup: isGroup
            };

            // Log faylına yazırıq (security kategoriyası)
            this.logger.security('📩 Yeni mesaj alındı', logData, 'security');

            // Terminala yazırıq
            console.log(
                `[${timestamp}] 📩 ${this.formatPhoneNumber(sender)} (${senderName}) ` +
                `${isGroup ? '[GROUP]' : '[PRIVATE]'}: ${text}`
            );

        } catch (err) {
            console.log("Mesaj loglama xətası:", err);
        }

        // 🔥 AUTO-BAN SİSTEMİ (yalnız şəxsi mesajlarda 1 dəqiqədə 10 mesaj limit)
        if (!isGroup) {
            const sender = message.from;
            const senderId = sender.split("@")[0];

            const normalizedPhone = this.normalizePhone(senderId);
            // Ban already checked at top of handleMessage, no need to check again here

            try {
                const now = Date.now();

                if (!this.messageSpam) this.messageSpam = {};
                if (!this.messageSpam[senderId]) {
                    this.messageSpam[senderId] = { count: 1, lastReset: now, warned: false };
                } else {
                    const diff = now - this.messageSpam[senderId].lastReset;

                    if (diff > 60 * 1000) {
                        this.messageSpam[senderId].count = 1;
                        this.messageSpam[senderId].lastReset = now;
                        this.messageSpam[senderId].warned = false;
                    } else {
                        this.messageSpam[senderId].count++;
                    }
                }

                if (this.messageSpam[senderId].count > 10) {
                    const normalizedForSpamBan = this.normalizePhone(senderId);
                    if (!this.dataManager.isBanned(normalizedForSpamBan)) {
                        this.dataManager.banUser(normalizedForSpamBan);

                        const senderName = message._data.notifyName || "Naməlum";

                        console.log(
                            `🚫 AUTO-BAN: ${this.formatPhoneNumber(normalizedForSpamBan)} (${senderName}) — 1 dəqiqədə çox mesaj göndərdi!`
                        );

                        this.logger.security("🚫 SPAM AUTO-BAN (normallaşdırılmış)", {
                            phone: normalizedForSpamBan,
                            name: senderName,
                            messagesLastMinute: this.messageSpam[senderId].count
                        }, "security");

                        if (!this.messageSpam[senderId].warned) {
                            this.messageSpam[senderId].warned = true;
                            try {
                                await message.reply(
                                    "🚫 *Spam limitini keçdiniz!*\n" +
                                    "Bot bunu **kiber hücum** kimi aşkarladı və sizi sistemdən *banladı*."
                                );
                            } catch { }
                        }
                    }
                    return;
                }
            } catch (err) {
                console.log("Auto-ban xətası:", err);
            }
        }

        // ⬇⬇ Bundan sonra sənin mövcud kodun davam edir
        await this.withPerformanceMonitoring('handleMessage', async () => {
            try {
                // ============================================================================
                // INPUT VALIDATION - Prevent crashes from invalid inputs
                // ============================================================================

                // Validate message object
                if (!message || !message.from) {
                    this.logger.warn('⚠️ Invalid message object received', { message }, 'system');
                    return;
                }

                // Validate message body
                if (!message.body || typeof message.body !== 'string') {
                    this.logger.debug('ℹ️ Message without body (media only or empty)', { from: message.from }, 'system');
                    // Allow media-only messages to pass through
                    if (!message.hasMedia) {
                        return; // Ignore empty messages without media
                    }
                }

                // Media size limit check (5MB = 5 * 1024 * 1024 bytes)
                if (message.hasMedia) {
                    try {
                        const media = await message.downloadMedia();
                        if (media && media.data) {
                            // Calculate size in MB
                            const sizeInBytes = Buffer.from(media.data, 'base64').length;
                            const sizeInMB = sizeInBytes / (1024 * 1024);

                            if (sizeInMB > 5) {
                                this.logger.warn('⚠️ Media too large', {
                                    from: message.from,
                                    sizeInMB: sizeInMB.toFixed(2)
                                }, 'system');

                                await message.reply(
                                    `❌ Fayl çox böyükdür (${sizeInMB.toFixed(2)}MB)\n\n` +
                                    `Maksimum fayl ölçüsü: 5MB\n` +
                                    `Zəhmət olmasa daha kiçik fayl göndərin.`
                                );
                                return;
                            }
                        }
                    } catch (mediaError) {
                        this.logger.error('❌ Media download error:', mediaError, 'system');
                        // Continue processing even if media download fails
                    }
                }

                const userPhone = senderIdRaw;
                const normalizedUserPhone = this.normalizePhone(userPhone);
                const messageBody = (message.body || '').trim();

                this.logger.debug('📩 Yeni mesaj', {
                    from: normalizedUserPhone,
                    body: messageBody,
                    isGroup: isGroup
                }, 'commands');

                // Ban yoxlaması (normalized)
                // Defensive ban check: if user is banned, silently stop processing (no replies)
                if (this.dataManager.isBanned(normalizedUserPhone)) {
                    this.logger.security('🚫 Banlı istifadəçi cəhdi (normallaşdırılmış) - gözardı edildi', { user: normalizedUserPhone }, 'security');
                    return;
                }

                // Salam mesajını /start kimi qəbul et
                // Salam mesajı yalnız şəxsi mesajda işləsin
                if (!isGroup && !messageBody.startsWith('/') && /^salam$/i.test(messageBody)) {
                    await this.startNewTicket(message);
                    return;
                }
                // =========================
                // 🔐 ADMIN LOGIN CHECK
                // =========================
                if (!isGroup) {
                    const loginState = this.adminLoginState.get(message.from);

                    // Step 1 — username
                    if (loginState === "ask_username") {
                        this.adminLoginState.set(message.from, {
                            step: "ask_password",
                            username: message.body.trim()
                        });
                        await message.reply("🔑 Şifrəni daxil edin:");
                        return;
                    }

                    // Step 2 — password
                    if (loginState && loginState.step === "ask_password") {
                        const username = loginState.username;
                        const password = message.body.trim();
                        const adminCredentials = this.configManager.get('adminCredentials');
                        const normalizedPhone = this.normalizePhone(message.from);

                        if (username === adminCredentials.username &&
                            password === adminCredentials.password) {

                            this.adminSessions.add(message.from);
                            this.adminLoginState.delete(message.from);
                            this.failedLoginAttempts.delete(normalizedPhone);

                            // ✅ Login edən istifadəçini avtomatik olaraq admins.js-ə əlavə et
                            const userIdWithSuffix = message.from; // e.g. "994506799917@c.us"
                            if (!this.dataManager.isAdmin(userIdWithSuffix)) {
                                this.dataManager.addAdmin(userIdWithSuffix);
                                this.logger.security('✅ Login edən istifadəçi admin kimi əlavə edildi', {
                                    phone: normalizedPhone,
                                    fullId: userIdWithSuffix
                                }, 'security');
                            }

                            this.logger.security('✅ Admin giriş uğurludur', { phone: normalizedPhone }, 'security');

                            await message.reply("✅ Admin giriş uğurludur! Artıq admin əmrlərindən istifadə edə bilərsiniz.");
                            return;
                        }

                        // Track failed attempt
                        const currentAttempts = this.failedLoginAttempts.get(normalizedPhone) || 0;
                        const newAttempts = currentAttempts + 1;
                        this.failedLoginAttempts.set(normalizedPhone, newAttempts);

                        this.logger.warn('🔒 Yanlış admin giriş cəhdi', {
                            phone: normalizedPhone,
                            attempts: newAttempts,
                            enteredUsername: username,
                            enteredPassword: password
                        }, 'security');

                        if (newAttempts >= 3) {
                            // Ban the user after 3 failed attempts
                            if (!this.dataManager.isBanned(normalizedPhone)) {
                                this.dataManager.banUser(normalizedPhone);
                            }
                            this.failedLoginAttempts.delete(normalizedPhone);

                            this.logger.security('🚫 İstifadəçi 3 səhv giriş cəhdi ilə banlandı (normallaşdırılmış)', { phone: normalizedPhone }, 'security');

                            await message.reply(
                                `🚫 *XƏBƏRDARLIQ: SİZİ SİSTEMDƏN BANLADIQ!*\n\n` +
                                `Admin girişində 3 dəfə yanlış parol daxil etdiniz.\n` +
                                `Sizə nömrə: ${this.formatPhoneNumber(normalizedPhone)}\n\n` +
                                `Eğer bu səhvdirsə, admin ilə əlaqə saxlayın.`
                            );
                            return;
                        }

                        const attemptsLeft = 3 - newAttempts;
                        await message.reply(`❌ Yanlış istifadəçi adı və ya şifrə!\n\n⚠️ Qalan cəhdlər: ${attemptsLeft} (${attemptsLeft === 1 ? 'Son cəhd!' : ''})`);
                        this.adminLoginState.delete(message.from);
                        return;
                    }
                }
                // Komandaları işlə
                if (await this.handleCommands(message, messageBody, isGroup)) return;

                // Ticket davamı
                if (!isGroup && this.userStates.has(userPhone)) {
                    await this.continueTicket(message);
                }

            } catch (error) {
                this.logger.error('❌ Mesaj emal xətası:', error, 'system');
            }
        });
    }
    async handleUnsolved(message) {
        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /unsolved <ticket_id>');
            return;
        }

        const ticketId = parseInt(parts[1]);

        try {
            const ticket = await this.db.get('SELECT id, status FROM tickets WHERE id = ?', [ticketId]);

            if (!ticket) {
                await this.sendQuickReply(message, '❌ Ticket tapılmadı!');
                return;
            }

            if (ticket.status !== 'solved') {
                await this.sendQuickReply(message, 'ℹ️ Bu ticket solved deyil.');
                return;
            }

            const sql = `
            UPDATE tickets
            SET status = 'open', solved_at = NULL, assigned_admin = NULL, solution = NULL
            WHERE id = ?
        `;
            await this.db.run(sql, [ticketId]);

            await this.sendQuickReply(message, `♻️ Ticket #${ticketId} yenidən açıldı.`);

        } catch (error) {
            this.logger.error('❌ Unsolved xətası:', error, 'tickets');
            await this.sendQuickReply(message, '❌ Ticket yenidən açılarkən xəta baş verdi.');
        }
    }

    // KOMMANDALAR
    async handleCommands(message, messageBody, isGroup) {
        this.logger.command(`🔧 Komanda işlənir: ${messageBody}`, {
            command: messageBody,
            from: message.from,
            isGroup: isGroup
        }, 'commands');

        // =========================
        // 🚫 QRUP KOMMANDALARI (Admin komandaları BLOKLANIR)
        // =========================
        if (isGroup) {
            // Prevent admin-only commands from working in groups — require private message
            try {
                const adminCommandsInGroup = [
                    '/ban', '/unban', '/listban', '/admin',
                    '/export', '/logexport', '/databaseexport', '/login', '/logout'
                ];

                if (adminCommandsInGroup.some(cmd => messageBody === cmd || messageBody.startsWith(cmd + ' '))) {
                    // Silently ignore as requested: "bot qrupa yazılan admin komandalarını komanda kimi görməməlidi"
                    return true;
                }
            } catch (err) {
                this.logger.error('❌ Qrup admin-komanda yoxlanışı xətası:', err, 'commands');
            }
        }

        // =========================
        // 🔐 /login — Admin giriş (yalnız şəxsi mesaj)
        // =========================
        if (!isGroup && messageBody === "/login") {
            this.adminLoginState.set(message.from, "ask_username");
            await message.reply("👤 İstifadəçi adını daxil edin:");
            return true;
        }

        // =========================
        // ↩️ /logout — Admin çıxış (yalnız şəxsi mesaj)
        // =========================
        if (!isGroup && messageBody === "/logout") {
            this.adminSessions.delete(message.from);
            await message.reply("↩️ Admin sessiyası sonlandırıldı.");
            return true;
        }

        // =========================
        // 🔒 ADMIN SESSION CHECK (yalnız şəxsi mesaj üçün)
        // =========================
        if (
            messageBody.startsWith('/ban') ||
            messageBody.startsWith('/unban') ||
            messageBody === '/listban' ||
            messageBody.startsWith('/admin') ||
            messageBody === '/export' ||
            messageBody === '/logexport' ||
            messageBody === '/databaseexport'
        ) {
            const normalizedSender = this.normalizePhone(message.from);
            const isPersistentAdmin = this.dataManager.isAdmin(normalizedSender);
            const hasSession = this.adminSessions.has(message.from);

            if (!hasSession && !isPersistentAdmin) {
                await message.reply("❌ Bu komanda üçün admin girişi tələb olunur.\n➡️ /login");
                return true;
            }
        }

        if (isGroup) {
            // YENİ KOMMANDALAR
            if (messageBody.startsWith('/longphoto')) {
                await this.handleLongPhoto(message);
                return true;
            }
            if (messageBody.startsWith('/announce')) {
                await this.handleAnnounce(message);
                return true;
            }
            if (messageBody === '/performance') {
                await this.handlePerformance(message);
                return true;
            }
            if (messageBody === '/logstats') {
                await this.handleLogStats(message);
                return true;
            }

            // TICKET İDARƏETMƏ
            if (messageBody === '/groupid') {
                await this.handleGroupId(message);
                return true;
            }
            if (messageBody === '/help') {
                await this.showHelp(message);
                return true;
            }
            if (messageBody.startsWith('/solved')) {
                await this.markSolved(message, message._data.notifyName || 'İstifadəçi');
                return true;
            }
            if (messageBody.startsWith('/long') && !messageBody.includes('list')) {
                await this.handleLongTerm(message, message._data.notifyName || 'İstifadəçi');
                return true;
            }
            if (messageBody === '/list') {
                await this.listTickets(message);
                return true;
            }
            if (messageBody === '/long list') {
                await this.listLongTerm(message);
                return true;
            }
            if (messageBody === '/stats') {
                await this.showStats(message);
                return true;
            }
            if (messageBody === '/today') {
                await this.showTodayStats(message);
                return true;
            }
            if (messageBody === '/ping') {
                await this.handlePing(message);
                return true;
            }
            if (messageBody.startsWith('/find')) {
                await this.handleFind(message);
                return true;
            }
            // Phase 3: New commands
            if (messageBody === '/sla') {
                await this.handleSLA(message);
                return true;
            }
            if (messageBody.startsWith('/search')) {
                await this.handleSearch(message);
                return true;
            }
            if (messageBody === '/adminperformance') {
                await this.handleAdminPerformance(message);
                return true;
            }

            // ❌ BURADA ARTİQ HEÇ BİR ADMIN KOMANDASI YOXDUR !!!
        }

        // =========================
        // ŞƏXSİ MESAJ KOMMANDALARI
        // =========================
        if (!isGroup && messageBody === '/start') {
            await this.startNewTicket(message);
            return true;
        }
        if (!isGroup && messageBody === '/stop') {
            await this.handleStop(message);
            return true;
        }
        if (!isGroup && messageBody === '/id show') {
            await this.handleIdShow(message);
            return true;
        }
        if (messageBody === '/mylimits') {
            await this.handleRateLimitStats(message);
            return true;
        }
        // Phase 3: User feedback command
        if (messageBody.startsWith('/rate')) {
            await this.handleRate(message);
            return true;
        }
        // Phase 3: Backup command (admin only in private)
        if (!isGroup && messageBody === '/backup') {
            const normalizedSender = this.normalizePhone(message.from);
            if (this.dataManager.isAdmin(normalizedSender) || this.adminSessions.has(message.from)) {
                await this.handleBackup(message);
            } else {
                await message.reply("❌ Bu komanda üçün admin girişi tələb olunur.\\n➡️ /login");
            }
            return true;
        }

        // Language switching command
        if (messageBody === '/lang' || messageBody.startsWith('/lang ')) {
            await this.handleLanguage(message);
            return true;
        }

        // /unsolved komandi
        if (isGroup && messageBody.startsWith('/unsolved')) {
            await this.handleUnsolved(message);
            return true;
        }

        // /export komandi (yalnız şəxsi mesaj)
        if (!isGroup && messageBody === '/export') {
            await this.handleExport(message);
            return true;
        }

        if (!isGroup && messageBody === '/logexport') {
            await this.handleLogExport(message);
            return true;
        }

        if (!isGroup && messageBody === '/databaseexport') {
            await this.handleDatabaseExport(message);
            return true;
        }

        // =========================
        // 🔥 ADMIN KOMANDALARI (yalnız şəxsi mesaj)
        // =========================
        if (messageBody.startsWith('/ban')) {
            await this.handleBan(message);
            return true;
        }

        if (messageBody.startsWith('/unban')) {
            await this.handleUnban(message);
            return true;
        }

        if (messageBody === '/listban') {
            await this.handleListBan(message);
            return true;
        }

        if (messageBody.startsWith('/admin add')) {
            await this.handleAdminAdd(message);
            return true;
        }

        if (messageBody === '/admin list') {
            await this.handleAdminList(message);
            return true;
        }

        if (messageBody.startsWith('/admin remove')) {
            await this.handleAdminRemove(message);
            return true;
        }

        if (messageBody.startsWith('/register')) {
            await this.handleRegister(message);
            return true;
        }

        if (messageBody.startsWith('/assign')) {
            await this.handleAssign(message);
            return true;
        }

        if (messageBody.startsWith('/noassign')) {
            await this.handleNoAssign(message);
            return true;
        }

        if (messageBody === '/stats') {
            await this.showStats(message);
            return true;
        }

        if (messageBody === '/today') {
            await this.showTodayStats(message);
            return true;
        }

        if (messageBody.startsWith('/find')) {
            await this.handleFind(message);
            return true;
        }

        return false;

    }


    // YENİ /longphoto KOMANDASI - TAM FONKSİONAL
    async handleLongPhoto(message) {
        try {
            const parts = message.body.split(' ');
            if (parts.length < 2) {
                await this.sendQuickReply(message, '❌ İstifadə: /longphoto <ticket_id>\n\n📸 Şəkil mesajını bu komandaya cavab olaraq göndərin!');
                return;
            }

            const ticketId = parseInt(parts[1]);
            const ticket = await this.db.get('SELECT id, status FROM tickets WHERE id = ?', [ticketId]);

            if (!ticket) {
                await this.sendQuickReply(message, '❌ Ticket tapılmadı!');
                return;
            }

            if (ticket.status !== 'long_term') {
                await this.sendQuickReply(message, '❌ Bu ticket uzunmüddətli statusunda deyil!');
                return;
            }

            // Media checking logic
            const hasMedia = message.hasMedia;
            const isQuoted = message.hasQuotedMsg;
            this.logger.debug('Longphoto şəkil yoxlaması', { hasMedia, isQuoted, type: message.type }, 'photos');
            let media;
            if (hasMedia) {
                media = await message.downloadMedia();
            } else if (isQuoted) {
                const quotedMsg = await message.getQuotedMessage();
                if (quotedMsg.hasMedia) {
                    media = await quotedMsg.downloadMedia();
                }
            }

            if (!media) {
                await this.sendQuickReply(message, '❌ Zəhmət olmasa şəkil göndərin!\n\n📸 Ya şəkili bu komandaya cavab olaraq göndərin, ya da şəkil ilə birlikdə komandanı yazın.');
                return;
            }

            if (!media.mimetype || !media.mimetype.startsWith('image/')) {
                await this.sendQuickReply(message, '❌ Yalnız şəkil faylları qəbul edilir! (JPEG, PNG, GIF)');
                return;
            }

            const fileSizeMB = (media.data.length * 3) / 4 / 1024 / 1024;
            const maxFileSize = this.configManager.get('photoSettings').maxFileSize;

            if (fileSizeMB > maxFileSize) {
                await this.sendQuickReply(message, `❌ Şəkil ölçüsü ${maxFileSize}MB-dan çox ola bilməz! Sizin şəkil: ${fileSizeMB.toFixed(2)}MB`);
                return;
            }

            // Check photo count limit from DB
            const photos = await this.db.all('SELECT id FROM long_photos WHERE ticket_id = ?', [ticketId]);
            const maxPhotos = this.configManager.get('photoSettings').maxPhotosPerTicket;

            if (photos.length >= maxPhotos) {
                await this.sendQuickReply(message, `❌ Hər ticket üçün maksimum ${maxPhotos} şəkil əlavə edilə bilər!`);
                return;
            }

            // Save the photo
            const photoNumber = photos.length + 1;
            const fileExtension = this.getFileExtension(media.mimetype);
            const fileName = `bilet_${ticketId}_${photoNumber}${fileExtension}`;
            const filePath = path.join('./longphoto', fileName);

            try {
                const fileBuffer = Buffer.from(media.data, 'base64');
                await fs.promises.writeFile(filePath, fileBuffer);
                const stats = await fs.promises.stat(filePath);
                if (stats.size === 0) throw new Error('Fayl boş yaradıldı');
            } catch (fileError) {
                this.logger.error('❌ Şəkil faylı yaradılma xətası:', fileError, 'photos');
                await this.sendQuickReply(message, '❌ Şəkil saxlanılarkən xəta baş verdi!');
                return;
            }

            // Update database
            const photoData = {
                ticket_id: ticketId,
                fileName: fileName,
                uploadedBy: message._data.notifyName || 'İstifadəçi',
                uploadTime: this.getBakuTime().format('YYYY-MM-DD HH:mm:ss'),
                fileSize: Math.round(fileSizeMB * 1024) + ' KB',
                uploadTimestamp: Date.now(),
                mimetype: media.mimetype
            };

            const sql = `
                INSERT INTO long_photos (ticket_id, fileName, uploadedBy, uploadTime, fileSize, uploadTimestamp, mimetype) 
                VALUES (?, ?, ?, ?, ?, ?, ?)
            `;
            await this.db.run(sql, Object.values(photoData));

            const successMessage = `✅ Şəkil uğurla əlavə edildi!\n\n` +
                `📁 Fayl: ${fileName}\n` +
                `📊 Ölçü: ${photoData.fileSize}\n` +
                `🔢 Nömrə: ${photoNumber}/${maxPhotos}\n` +
                `⏰ Vaxt: ${this.getBakuTime().format('HH:mm:ss')}`;

            await this.sendQuickReply(message, successMessage);

            this.logger.photo('📸 Şəkil əlavə edildi', {
                ticketId: ticketId,
                fileName: fileName,
                fileSize: photoData.fileSize,
                uploadedBy: photoData.uploadedBy,
                photoNumber: photoNumber,
                totalPhotos: photos.length + 1,
                mimetype: media.mimetype
            }, 'photos');

        } catch (error) {
            this.logger.error('❌ Longphoto xətası:', error, 'photos');
            await this.sendQuickReply(message, '❌ Şəkil əlavə edilərkən xəta baş verdi!');
        }
    }

    getFileExtension(mimetype) {
        const extensions = {
            'image/jpeg': '.jpg',
            'image/jpg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp'
        };
        return extensions[mimetype] || '.jpg';
    }

    // YENİ /announce KOMANDASI - HƏR KƏSİ TAGLAYIR
    // DƏYIŞDIR: handleAnnounce funksiyasını aşağıdakı ilə əvəz edin
    async handleAnnounce(message) {
        try {
            const parts = message.body.split(' ');
            if (parts.length < 2) {
                await this.sendQuickReply(message, '❌ İstifadə: /announce <mesaj>');
                return;
            }

            const announcement = parts.slice(1).join(' ');
            const groupId = this.configManager.get('traineeGroupId');

            if (!groupId) {
                await this.sendQuickReply(message, '❌ Qrup ID təyin olunmayıb!');
                return;
            }

            const groupChat = await this.client.getChatById(groupId);
            const participants = groupChat.participants || [];

            const mentionList = participants
                .map(p => p.id?._serialized || null)
                .filter(Boolean);

            // GİZLİ MENTION: mesajda heç bir @ yoxdur
            const announceMessage =
                `📢 ELAN\n\n${announcement}\n\n` +
                `⏰ ${this.getBakuTime().format('DD.MM.YYYY HH:mm:ss')}`;

            await this.client.sendMessage(groupId, announceMessage, {
                mentions: mentionList // GİZLİ MENTION BURADA
            });

        } catch (error) {
            this.logger.error('❌ Announce xətası:', error, 'commands');
            await this.sendQuickReply(message, '❌ Elan göndərilərkən xəta baş verdi!');
        }
    }

    // YENİ LOG STATİSTİKA KOMANDASI
    async handleLogStats(message) {
        try {
            const logStats = await this.logger.getLogStats();
            let statsMessage = `📊 LOG STATİSTİKALARI\n\n`;

            for (const [category, count] of Object.entries(logStats)) {
                statsMessage += `${category.toUpperCase()}: ${count} log\n`;
            }

            statsMessage += `\n🕐 ${this.getBakuTime().format('DD.MM.YYYY HH:mm:ss')}`;

            await this.sendQuickReply(message, statsMessage);

            this.logger.info('📊 Log statistikaları göstərildi', logStats, 'system');

        } catch (error) {
            this.logger.error('❌ Log stats xətası:', error, 'system');
            await this.sendQuickReply(message, '❌ Log statistikaları gətirilərkən xəta baş verdi!');
        }
    }

    // TICKET SİSTEMİ
    async startNewTicket(message) {
        const userPhone = message.from;
        const normalizedPhone = this.normalizePhone(userPhone);

        // Ban check - this should never be reached due to global check in handleMessage, but kept as safety
        if (this.dataManager.isBanned(normalizedPhone)) {
            this.logger.security('🚫 Banlı istifadəçi ticket yaratma cəhdi (normallaşdırılmış)', { user: normalizedPhone }, 'security');
            return; // Silently ignore - no reply to banned users
        }

        // RATE LİMİT YOXLAMASI
        const limitCheck = this.rateLimiter.canCreateTicket(userPhone);
        if (!limitCheck.allowed) {
            let errorMessage = '';

            switch (limitCheck.period) {
                case 'minute':
                    errorMessage = `❌ Dəqiqədə 1-dən çox ticket yarada bilməzsiniz. Zəhmət olmasa ${this.rateLimiter.formatRemainingTime(limitCheck.remainingTime)} gözləyin.`;
                    break;
                case 'hour':
                    errorMessage = `❌ Saatda 5-dən çox ticket yarada bilməzsiniz. Zəhmət olmasa ${this.rateLimiter.formatRemainingTime(limitCheck.remainingTime)} gözləyin.`;
                    break;
                case 'day':
                    errorMessage = `❌ Gündə 20-dən çox ticket yarada bilməzsiniz. Sabah yenidən cəhd edin.`;
                    break;
            }

            if (limitCheck.currentCount >= limitCheck.maxLimit - 1) {
                errorMessage += `\n\n⚠️ Diqqət: ${limitCheck.currentCount}/${limitCheck.maxLimit} limitə yaxınlaşmısınız!`;
            }

            await this.sendQuickReply(message, errorMessage);
            return;
        }

        const userName = message._data.notifyName || 'İstifadəçi';

        this.logger.ticket('🚀 Yeni ticket başladı:', { user: userName, number: userPhone }, 'tickets');

        const userState = {
            step: 1,
            username: userName,
            userPhone: userPhone,
            startTime: new Date(),
            attempts: 0
        };

        this.userStates.set(userPhone, userState);

        await this.sendQuickReply(message, this.getWelcomeMessage());
    }

    getWelcomeMessage() {
        return `🎓 ADNSU IT Dəstək sisteminə xoş gəlmisiniz!\n\nKorpus nömrəsini daxil edin (1 və ya 2)(ticket prosesini dayandırmaq üçün */stop* yazın):`;
    }

    async continueTicket(message) {
        const userPhone = message.from;
        const userState = this.userStates.get(userPhone);
        if (!userState) return;

        try {
            userState.attempts++;

            switch (userState.step) {
                case 1: await this.handleStep1(message, userState); break;
                case 2: await this.handleStep2(message, userState); break;
                case 3: await this.handleStep3(message, userState); break;
                case 4: await this.handleStep4(message, userState); break;
            }
        } catch (error) {
            this.logger.error('❌ Ticket xətası:', error, 'tickets');
            await this.handleTicketError(message, userPhone, error);
        }
    }

    async handleStep1(message, userState) {
        if (!['1', '2'].includes(message.body)) {
            await this.sendQuickReply(message, '❌ Yalnız 1 və ya 2 daxil edin:');
            return;
        }
        userState.corpus = message.body;
        userState.step = 2;
        await this.sendQuickReply(message, '🏢 Otaq nömrəsini daxil edin:');
    }

    async handleStep2(message, userState) {
        const roomNumber = message.body.trim().toUpperCase();

        if (roomNumber.length > 10) {
            await this.sendQuickReply(message, '❌ Otaq nömrəsi maksimum 10 simvol ola bilər.');
            return;
        }

        const match = roomNumber.match(/^(\d+)/);

        if (!match) {
            await this.sendQuickReply(message, '❌ Otaq nömrəsi rəqəmlə başlamalıdır.');
            return;
        }

        const mainNumber = parseInt(match[1], 10);
        const restOfString = roomNumber.substring(match[1].length).trim();

        if (userState.corpus === '1') {
            if (mainNumber < 101 || mainNumber > 543) {
                await this.sendQuickReply(message, '❌ 1-ci korpus üçün otaq nömrəsi 101 ilə 543 arasında olmalıdır.');
                return;
            }
        } else if (userState.corpus === '2') {
            if (mainNumber < 1101 || mainNumber > 1644) {
                await this.sendQuickReply(message, '❌ 2-ci korpus üçün otaq nömrəsi 1101 ilə 1644 arasında olmalıdır.');
                return;
            }
        }

        // Yalnız icazə verilən simvolları yoxlayın (A-E, rəqəmlər, boşluq)
        if (/[^A-E0-9\s]/.test(restOfString)) {
            await this.sendQuickReply(message, '❌ Otaq nömrəsində əsas nömrədən sonra yalnız A-E hərfləri, 1-13 arası rəqəmlər və ya boşluq ola bilər.');
            return;
        }

        // Əlavə nömrələrin 1-13 aralığında olub olmadığını yoxlayın
        const numbersInRest = restOfString.match(/\d+/g);
        if (numbersInRest) {
            for (const numStr of numbersInRest) {
                const num = parseInt(numStr, 10);
                if (num < 1 || num > 13) {
                    await this.sendQuickReply(message, '❌ Otaq nömrəsindəki əlavə kabinet nömrəsi 1 ilə 13 arasında olmalıdır.');
                    return;
                }
            }
        }

        userState.room = roomNumber;
        userState.step = 3;
        await this.showProblemTypes(message);
    }

    async showProblemTypes(message) {
        let problemList = '🔧 Problem növünü seçin (1-16):\n\n';

        for (const [key, value] of Object.entries(this.problemTypesExtended)) {
            problemList += `${key}. ${value}\n`;
        }

        problemList += '\n📝 Seçiminizi rəqəmlə daxil edin:';

        await this.sendQuickReply(message, problemList);
    }

    async handleStep3(message, userState) {
        const choice = message.body.trim();

        if (choice === '16') {
            userState.step = 4;
            await this.sendQuickReply(message, '✍️ Problemi özünüz yazın (maksimum 100 simvol):');
            return;
        }

        if (!this.problemTypesExtended[choice]) {
            await this.sendQuickReply(message, '❌ Yanlış seçim! 1-16 arası rəqəm daxil edin:');
            return;
        }

        userState.problemType = this.problemTypesExtended[choice];
        await this.completeTicket(message, userState);
    }

    async handleStep4(message, userState) {
        const customProblem = message.body.trim();

        if (customProblem.length > 100) {
            await this.sendQuickReply(message, '❌ Problem təsviri maksimum 100 simvol olmalıdır! Yenidən daxil edin:');
            return;
        }

        if (customProblem.length === 0) {
            await this.sendQuickReply(message, '❌ Problem təsviri boş ola bilməz! Yenidən daxil edin:');
            return;
        }

        userState.problemType = customProblem;
        await this.completeTicket(message, userState);
    }

    async completeTicket(message, userState) {
        await this.withPerformanceMonitoring('completeTicket', async () => {
            try {
                const createdAt = this.getBakuTime().format('YYYY-MM-DD HH:mm:ss');
                const sql = `
                    INSERT INTO tickets (user_id, username, phone, corpus, room, problem_type, status, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `;

                const result = await this.db.run(sql, [
                    userState.userPhone,
                    userState.username,
                    this.formatPhoneNumber(userState.userPhone), // Save formatted phone
                    userState.corpus,
                    userState.room,
                    userState.problemType,
                    'open',
                    createdAt
                ]);

                const ticketId = result.id;

                this.logger.ticket('🎫 Ticket yaradıldı:', {
                    ticketId: ticketId,
                    user: userState.username,
                    userPhone: userState.userPhone,
                    formattedPhone: this.formatPhoneNumber(userState.userPhone),
                    corpus: userState.corpus,
                    room: userState.room,
                    problemType: userState.problemType
                }, 'tickets');

                console.log(
                    `[${createdAt}] 🎫 Yeni Ticket #${ticketId} — ` +
                    `${this.formatPhoneNumber(userState.userPhone)} (${userState.username}) ` +
                    `K${userState.corpus}-${userState.room} — ${userState.problemType}`
                );

                this.rateLimiter.recordTicketCreation(userState.userPhone);

                const successMessage = `✅ Problem qeydə alındı! ID: #${ticketId}\n\n` +
                    `⏰ Açılma vaxtı: ${this.getBakuTime().format('DD.MM.YYYY HH:mm:ss')}\n\n` +
                    `Yeni problem üçün Salam yazın`;

                await this.sendQuickReply(message, successMessage);

                await this.sendToGroup(ticketId, userState);

                this.userStates.delete(userState.userPhone);

            } catch (error) {
                this.logger.error('❌ Ticket yaratma xətası:', error, 'tickets');
                await this.sendQuickReply(message, '❌ Ticket yaradılarkən xəta baş verdi. Zəhmət olmasa yenidən cəhd edin.');
                this.userStates.delete(userState.userPhone);
            }
        });
    }

    async sendToGroup(ticketId, userState) {
        const groupId = this.configManager.get('traineeGroupId');
        if (!groupId) {
            this.logger.warn('❌ Qrup ID təyin olunmayıb - ticket qrupa göndərilmədi', { ticketId: ticketId }, 'tickets');
            return;
        }

        try {


            const groupMessage = `🎫 YENİ TICKET #${ticketId}\n\n` +
                `👤 ${userState.username}\n` +
                `🏢 K${userState.corpus}-${userState.room}\n` +
                `🔧 ${userState.problemType}\n\n` +
                `⏰ ${this.getBakuTime().format('DD.MM.YYYY HH:mm:ss')}\n\n` +
                `✅ /solved ${ticketId} <həll üsulu>\n` +
                `⏳ /long ${ticketId}\n` +
                `📸 /longphoto ${ticketId}`;
            await this.client.sendMessage(groupId, groupMessage);

            this.logger.ticket('✅ Ticket qrupa göndərildi:', { ticketId: ticketId, groupId: groupId }, 'tickets');

        } catch (error) {
            this.logger.error('❌ Qrupa göndərmə xətası:', error, 'tickets');
        }
    }

    // TICKET ƏMƏLİYYATLARI
    async markSolved(message, adminName) {
        const parts = message.body.split(' ');
        if (parts.length < 3) {
            await this.sendQuickReply(message, '❌ İstifadə: /solved <ticket_id> <həll üsulu>');
            return;
        }

        const ticketId = parseInt(parts[1]);
        const solution = parts.slice(2).join(' ');

        try {
            const ticket = await this.db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
            if (!ticket) {
                await this.sendQuickReply(message, '❌ Ticket tapılmadı!');
                return;
            }

            if (ticket.status === 'solved') {
                await this.sendQuickReply(message, '❌ Bu ticket artıq həll edilib!');
                return;
            }

            const solvedAt = this.getBakuTime().format('YYYY-MM-DD HH:mm:ss');
            const solveDuration = this.calculateSolveDuration(ticket.created_at, solvedAt);

            const adminPhone = this.normalizePhone(message.from);

            // Get admin name from profile if exists
            const adminProfile = await this.db.get(`SELECT name FROM admin_profiles WHERE phone = ?`, [adminPhone]);
            const actualAdminName = adminProfile ? adminProfile.name : adminName;

            const sql = `
                UPDATE tickets 
                SET status = ?, assigned_admin = ?, assigned_admin_name = ?, solution = ?, solved_at = ?, solved_by_phone = ?
                WHERE id = ?
            `;
            await this.db.run(sql, ['solved', adminPhone, actualAdminName, solution, solvedAt, adminPhone, ticketId]);


            const response = `✅ TICKET HƏLL EDİLDİ #${ticketId}\n\n` +
                `👤 ${ticket.username}\n` +
                `🏢 K${ticket.corpus}-${ticket.room}\n` +
                `🔧 ${ticket.problem_type}\n` +
                `🛠️ Həll: ${solution}\n` +
                `👨‍🔧 Təcrübəçi: ${actualAdminName}\n` +
                `⏱️ Həll müddəti: ${solveDuration}\n` +
                `🕐 ${solvedAt}`;

            await this.sendQuickReply(message, response);

            this.logger.ticket('✅ Ticket həll edildi:', {
                ticketId: ticketId,
                admin: actualAdminName,
                duration: solveDuration,
                solution: solution
            }, 'tickets');

        } catch (error) {
            this.logger.error('❌ Solved xətası:', error, 'tickets');
            await this.sendQuickReply(message, '❌ Ticket yenilənərkən xəta baş verdi!');
        }
    }

    async handleLongTerm(message, adminName) {
        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /long <ticket_id>');
            return;
        }

        const ticketId = parseInt(parts[1]);

        try {
            const ticket = await this.db.get('SELECT * FROM tickets WHERE id = ?', [ticketId]);
            if (!ticket) {
                await this.sendQuickReply(message, '❌ Ticket tapılmadı!');
                return;
            }

            if (ticket.status !== 'open') {
                await this.sendQuickReply(message, `❌ Bu ticket artıq ${ticket.status} statusundadır!`);
                return;
            }

            const adminPhone = this.normalizePhone(message.from);

            // Get admin name from profile if exists
            const adminProfile = await this.db.get(`SELECT name FROM admin_profiles WHERE phone = ?`, [adminPhone]);
            const actualAdminName = adminProfile ? adminProfile.name : adminName;

            const longTermAt = this.getBakuTime().format('YYYY-MM-DD HH:mm:ss');
            const sql = `
                UPDATE tickets 
                SET status = ?, assigned_admin = ?, assigned_admin_name = ?, solved_at = ?
                WHERE id = ?
            `;
            await this.db.run(sql, ['long_term', adminPhone, actualAdminName, longTermAt, ticketId]);


            const response = `⏳ TICKET UZUNMÜDDƏTLİ #${ticketId}\n\n` +
                `👤 ${ticket.username}\n` +
                `🏢 K${ticket.corpus}-${ticket.room}\n` +
                `🔧 ${ticket.problem_type}\n` +
                `👨‍🔧 Admin: ${actualAdminName}\n` +
                `🕐 ${longTermAt}\n\n` +
                `✅ /solved ${ticketId} <həll üsulu>\n` +
                `📸 /longphoto ${ticketId}`;

            await this.sendQuickReply(message, response);

            this.logger.ticket('✅ Ticket uzunmüddətli edildi:', { ticketId: ticketId, admin: actualAdminName }, 'tickets');

        } catch (error) {
            this.logger.error('❌ Long term xətası:', error, 'tickets');
            await this.sendQuickReply(message, '❌ Ticket yenilənərkən xəta baş verdi!');
        }
    }

    async listTickets(message) {
        try {
            const tickets = await this.db.all("SELECT * FROM tickets WHERE status = 'open' ORDER BY id ASC");

            if (tickets.length === 0) {
                await this.sendQuickReply(message, 'ℹ️ Hal-hazırda açıq ticket yoxdur.');
                return;
            }

            let ticketList = `📋 AÇIQ TICKETLAR (${tickets.length})\n\n`;

            tickets.forEach((ticket, index) => {
                const time = moment(ticket.created_at).format('DD.MM HH:mm');
                const openDuration = this.calculateOpenDuration(ticket.created_at);

                ticketList += `${index + 1}. #${ticket.id} - K${ticket.corpus}-${ticket.room}\n`;
                ticketList += `   🔧 ${ticket.problem_type}\n`;
                ticketList += `   👤 ${ticket.username}\n`;

                if (ticket.assigned_admin) {
                    const adminInfo = ticket.assigned_admin_name ? `${ticket.assigned_admin_name} (${this.formatPhoneNumber(ticket.assigned_admin)})` : this.formatPhoneNumber(ticket.assigned_admin);
                    ticketList += `   👷 ${adminInfo}\n`;
                }

                ticketList += `   ⏰ Açıq vaxt: ${openDuration}\n`;
                ticketList += `   🕐 ${time}\n`;
                ticketList += `   ✅ /solved ${ticket.id} <həll>\n`;
                ticketList += `   ⏳ /long ${ticket.id}\n`;
                ticketList += `   ──────────────────────\n`;

            });

            const messageParts = this.splitMessage(ticketList, 4096);

            for (const part of messageParts) {
                await this.sendQuickReply(message, part);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            this.logger.ticket('📋 Açıq ticketlar listələndi:', { count: tickets.length }, 'tickets');

        } catch (error) {
            this.logger.error('❌ List xətası:', error, 'tickets');
            await this.sendQuickReply(message, '❌ Ticketlar gətirilərkən xəta baş verdi!');
        }
    }

    async listLongTerm(message) {
        try {
            const tickets = await this.db.all("SELECT * FROM tickets WHERE status = 'long_term' ORDER BY id ASC");

            if (tickets.length === 0) {
                await this.sendQuickReply(message, 'ℹ️ Hal-hazırda uzunmüddətli ticket yoxdur.');
                return;
            }

            // Fetch all photos for the found tickets at once to avoid N+1 queries
            const ticketIds = tickets.map(t => t.id);
            const placeholder = ticketIds.map(() => '?').join(',');
            const allPhotos = await this.db.all(`SELECT * FROM long_photos WHERE ticket_id IN (${placeholder})`, ticketIds);

            // Group photos by ticket_id for easy lookup
            const photosByTicket = allPhotos.reduce((acc, photo) => {
                if (!acc[photo.ticket_id]) {
                    acc[photo.ticket_id] = [];
                }
                acc[photo.ticket_id].push(photo);
                return acc;
            }, {});

            let ticketList = `⏳ UZUNMÜDDƏTLİ TICKETLAR (${tickets.length})\n\n`;

            tickets.forEach((ticket, index) => {
                const time = moment(ticket.created_at).format('DD.MM HH:mm');
                const solvedTime = ticket.solved_at ?
                    moment(ticket.solved_at).format('DD.MM HH:mm') : 'Yoxdur';
                const openDuration = this.calculateOpenDuration(ticket.created_at);

                ticketList += `${index + 1}. #${ticket.id} - K${ticket.corpus}-${ticket.room}\n`;
                ticketList += `   🔧 ${ticket.problem_type}\n`;
                ticketList += `   👤 ${ticket.username}\n`;
                ticketList += `   ⏰ Açıq vaxt: ${openDuration}\n`;
                ticketList += `   🕐 Açılma: ${time}\n`;
                ticketList += `   ⏰ Long: ${solvedTime}\n`;
                ticketList += `   👨‍🔧 ${ticket.assigned_admin || 'Yoxdur'}\n`;

                // Get photo info from our map
                const photos = photosByTicket[ticket.id];
                if (photos && photos.length > 0) {
                    const maxPhotos = this.configManager.get('photoSettings').maxPhotosPerTicket;
                    ticketList += `   📸 Şəkillər: ${photos.length}/${maxPhotos}\n`;
                    photos.forEach((photo, photoIndex) => {
                        // Ensure uploadTime is valid before formatting
                        const uploadTimeMoment = photo.uploadTime ? moment(photo.uploadTime, 'YYYY-MM-DD HH:mm:ss') : null;
                        const formattedUploadTime = uploadTimeMoment && uploadTimeMoment.isValid() ? uploadTimeMoment.format('DD.MM HH:mm') : 'Naməlum vaxt';
                        ticketList += `      ${photoIndex + 1}. ${photo.fileName} (${formattedUploadTime})\n`;
                    });
                }

                ticketList += `   ✅ /solved ${ticket.id} <həll>\n`;
                ticketList += `   📸 /longphoto ${ticket.id}\n`;
                ticketList += `   ──────────────────────\n`;
            });

            const messageParts = this.splitMessage(ticketList, 4096);

            for (const part of messageParts) {
                await this.sendQuickReply(message, part);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            this.logger.ticket('⏳ Uzunmüddətli ticketlar listələndi:', { count: tickets.length }, 'tickets');

        } catch (error) {
            this.logger.error('❌ Long list xətası:', error, 'tickets');
            await this.sendQuickReply(message, '❌ Uzunmüddətli ticketlar gətirilərkən xəta baş verdi!');
        }
    }

    async showStats(message) {
        try {
            const stats = await this.db.get(`
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open,
                    SUM(CASE WHEN status = 'solved' THEN 1 ELSE 0 END) AS solved,
                    SUM(CASE WHEN status = 'long_term' THEN 1 ELSE 0 END) AS long_term
                FROM tickets
            `);
            const todayStats = await this.db.get("SELECT COUNT(*) AS count FROM tickets WHERE date(created_at) = date('now', 'localtime')");

            const solvedTickets = await this.db.all("SELECT created_at, solved_at FROM tickets WHERE status = 'solved' AND solved_at IS NOT NULL");
            let averageSolveTime = 'Hesablanır...';

            if (solvedTickets.length > 0) {
                let totalSolveTime = 0;
                solvedTickets.forEach(ticket => {
                    const solveDuration = moment(ticket.solved_at).diff(moment(ticket.created_at), 'minutes');
                    totalSolveTime += solveDuration;
                });
                const avgMinutes = Math.round(totalSolveTime / solvedTickets.length);
                if (avgMinutes < 60) {
                    averageSolveTime = `${avgMinutes} dəqiqə`;
                } else {
                    averageSolveTime = `${Math.floor(avgMinutes / 60)} saat ${avgMinutes % 60} dəqiqə`;
                }
            }

            // Admin Stats Calculation
            const adminStatsRaw = await this.db.all(`
                SELECT 
                    COALESCE(assigned_admin_name, assigned_admin) as admin_identifier,
                    COUNT(*) as count
                FROM tickets 
                WHERE (status = 'solved' OR status = 'long_term') AND assigned_admin IS NOT NULL
                GROUP BY admin_identifier
                ORDER BY count DESC
            `);

            let adminStatsText = '';
            if (adminStatsRaw.length > 0) {
                adminStatsText = `\n👨‍🔧 ADMIN STATİSTİKASI:\n`;
                adminStatsRaw.forEach(stat => {
                    // Try to format if it's a phone number, otherwise leave as name
                    let displayName = stat.admin_identifier;
                    if (/^\d+$/.test(displayName)) {
                        displayName = this.formatPhoneNumber(displayName);
                    }
                    adminStatsText += `   • ${displayName}: ${stat.count} ticket\n`;
                });
            }

            const response = `📊 ADNSU IT STATİSTİKA\n\n` +
                `📋 Ümumi ticket: ${stats.total || 0}\n` +
                `⏳ Açıq: ${stats.open || 0}\n` +
                `✅ Həll edilən: ${stats.solved || 0}\n` +
                `⏰ Uzunmüddətli: ${stats.long_term || 0}\n` +
                `📅 Bu gün: ${todayStats.count || 0}\n` +
                `⏱️ Orta həll müddəti: ${averageSolveTime}\n` +
                `${adminStatsText}\n` +
                `🕐 ${this.getBakuTime().format('DD.MM.YYYY HH:mm:ss')}`;


            await this.sendQuickReply(message, response);

            this.logger.info('📊 Statistika göstərildi', {
                total: stats.total || 0,
                open: stats.open || 0,
                solved: stats.solved || 0,
                long_term: stats.long_term || 0,
                today: todayStats.count || 0,
                averageSolveTime: averageSolveTime
            }, 'system');

        } catch (error) {
            this.logger.error('❌ Stats xətası:', error, 'system');
            await this.sendQuickReply(message, '❌ Statistikalar gətirilərkən xəta baş verdi!');
        }
    }

    async showTodayStats(message) {
        try {
            const tickets = await this.db.all("SELECT * FROM tickets WHERE date(created_at) = date('now', 'localtime') ORDER BY id ASC");

            if (tickets.length === 0) {
                await this.sendQuickReply(message, `📅 Bu gün (${this.getBakuTime().format('DD.MM.YYYY')}) heç bir ticket yoxdur.`);
                return;
            }

            let statsMessage = `📅 BU GÜNKÜ TICKETLAR (${tickets.length})\n\n`;

            tickets.forEach((ticket, index) => {
                const time = moment(ticket.created_at).format('HH:mm');
                const status = ticket.status === 'open' ? '⏳' :
                    ticket.status === 'solved' ? '✅' : '⏰';

                statsMessage += `${index + 1}. ${status} #${ticket.id} - K${ticket.corpus}-${ticket.room}\n`;
                statsMessage += `   👤 ${ticket.username}\n`;
                statsMessage += `   🔧 ${ticket.problem_type}\n`;
                statsMessage += `   🕐 ${time}\n`;

                if (ticket.assigned_admin) {
                    statsMessage += `   👨‍🔧 ${ticket.assigned_admin}\n`;
                }
                if (ticket.status === 'solved' && ticket.solution) {
                    statsMessage += `   🛠️ ${ticket.solution}\n`;
                }

                statsMessage += `   ──────────────────────\n`;
            });

            const messageParts = this.splitMessage(statsMessage, 4096);
            for (const part of messageParts) {
                await this.sendQuickReply(message, part);
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            this.logger.info('📅 Bugünkü statistikalar göstərildi', { count: tickets.length }, 'system');

        } catch (error) {
            this.logger.error('❌ Today stats xətası:', error, 'system');
            await this.sendQuickReply(message, '❌ Bugünkü statistikalar gətirilərkən xəta baş verdi!');
        }
    }

    async handleFind(message) {
        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /find <açar söz>');
            return;
        }

        const searchTerm = parts.slice(1).join(' ');

        try {
            const searchTermLike = `%${searchTerm.toLowerCase()}%`;
            const tickets = await this.db.all(
                `SELECT * FROM tickets WHERE 
                    LOWER(problem_type) LIKE ? OR 
                    LOWER(username) LIKE ? OR 
                    LOWER(room) LIKE ?
                ORDER BY id DESC`,
                [searchTermLike, searchTermLike, searchTermLike]
            );

            if (tickets.length === 0) {
                await this.sendQuickReply(message, `❌ "${searchTerm}" üçün heç bir nəticə tapılmadı.`);
                return;
            }

            let searchResults = `🔍 AXTARİŞ NƏTİCƏLƏRİ: "${searchTerm}" (${tickets.length} tapıldı)\n\n`;

            tickets.forEach((ticket, index) => {
                const time = moment(ticket.created_at).format('DD.MM.YYYY HH:mm');
                const status = ticket.status === 'open' ? '⏳' :
                    ticket.status === 'solved' ? '✅' : '⏰';

                searchResults += `${index + 1}. ${status} #${ticket.id}\n`;
                searchResults += `   👤 ${ticket.username}\n`;
                searchResults += `   🏢 K${ticket.corpus}-${ticket.room}\n`;
                searchResults += `   🔧 ${ticket.problem_type}\n`;
                searchResults += `   🕐 ${time}\n`;
                searchResults += `   📊 ${ticket.status}\n`;

                if (ticket.assigned_admin) {
                    searchResults += `   👨‍🔧 ${ticket.assigned_admin}\n`;
                }

                searchResults += `   ──────────────────────\n`;
            });

            const messageParts = this.splitMessage(searchResults, 4096);

            for (const part of messageParts) {
                await this.sendQuickReply(message, part);
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            this.logger.info('🔍 Axtarış edildi:', { searchTerm: searchTerm, resultCount: tickets.length }, 'system');

        } catch (error) {
            this.logger.error('❌ Find xətası:', error, 'system');
            await this.sendQuickReply(message, '❌ Axtarış zamanı xəta baş verdi!');
        }
    }

    async handlePing(message) {
        const startTime = Date.now();

        await this.withPerformanceMonitoring('handlePing', async () => {
            const bakuTime = this.getBakuTime().format('DD.MM.YYYY HH:mm:ss');

            // Fetch counts from DB and DataManager
            const banCount = this.dataManager.getBannedUsers().length;
            const ticketCountResult = await this.db.get('SELECT COUNT(*) AS count FROM tickets');
            const pingTime = Date.now() - startTime;

            const performanceStatus = pingTime > 2000 ? '❌' : '✅';
            const rateLimitUsers = this.rateLimiter.userTickets.size;

            await this.sendQuickReply(message,
                `🏓 PONG! ${performanceStatus}\n\n` +
                `⏱️ Cavab müddəti: ${pingTime}ms\n` +
                `📊 Orta cavab müddəti: ${this.performanceStats.averageResponseTime.toFixed(2)}ms\n` +
                `🕐 Server vaxtı: ${bakuTime}\n` +
                `👤 Aktiv ticket: ${this.userStates.size}\n` +
                `📊 Rate limit istifadəçi: ${rateLimitUsers}\n` +
                `🔨 Banlı istifadəçi: ${banCount}\n` +
                `🎫 Ümumi ticket: ${ticketCountResult.count || 0}\n` +
                `🐌 Yavaş əməliyyatlar: ${this.performanceStats.slowOperations}`
            );

            this.logger.info('🏓 Ping komandası işlədildi', { pingTime: pingTime }, 'commands');
        });
    }

    async handlePerformance(message) {
        await this.withPerformanceMonitoring('handlePerformance', async () => {
            try {
                const stats = this.performanceStats;
                const rateLimitUsers = this.rateLimiter.userTickets.size;
                const banCount = this.dataManager.getBannedUsers().length;

                const performanceMessage = `⚡ PERFORMANS STATİSTİKASI\n\n` +
                    `📊 Ümumi mesaj: ${stats.totalMessages}\n` +
                    `⏱️ Orta cavab müddəti: ${stats.averageResponseTime.toFixed(2)}ms\n` +
                    `🐌 Yavaş əməliyyatlar: ${stats.slowOperations}\n` +
                    `👥 Aktiv rate limit: ${rateLimitUsers} istifadəçi\n` +
                    `🎫 Aktiv ticket prosesi: ${this.userStates.size}\n` +
                    `🔨 Banlı istifadəçi: ${banCount}\n\n` +
                    `🕐 ${this.getBakuTime().format('DD.MM.YYYY HH:mm:ss')}`;

                await this.sendQuickReply(message, performanceMessage);

                this.logger.info('⚡ Performans statistikası göstərildi', null, 'performance');

            } catch (error) {
                this.logger.error('❌ Performans statistikası xətası:', error, 'performance');
                await this.sendQuickReply(message, '❌ Performans statistikaları gətirilərkən xəta baş verdi!');
            }
        });
    }

    async handleRateLimitStats(message) {
        await this.withPerformanceMonitoring('handleRateLimitStats', async () => {
            try {
                const userPhone = message.from;
                const userStats = this.rateLimiter.getUserStats(userPhone);

                if (!userStats) {
                    await this.sendQuickReply(message, 'ℹ️ Hal-hazırda heç bir ticket limitiniz yoxdur.');
                    return;
                }

                let statsMessage = `📊 SİZİN TICKET LİMİTLƏRİNİZ\n\n`;

                for (const [period, stats] of Object.entries(userStats)) {
                    const limit = this.rateLimiter.limits[period];
                    const remainingTime = stats.resetTime - Date.now();
                    const remainingTickets = limit.max - stats.count;

                    statsMessage += `🕐 ${period.toUpperCase()}:\n`;
                    statsMessage += `   📝 İstifadə: ${stats.count}/${limit.max}\n`;
                    statsMessage += `   ✅ Qalan: ${remainingTickets}\n`;
                    statsMessage += `   ⏰ Sıfırlanma: ${this.rateLimiter.formatRemainingTime(remainingTime)}\n\n`;
                }

                // Proaktif xəbərdarlıq
                const minuteStats = userStats.minute;
                const hourStats = userStats.hour;
                const dayStats = userStats.day;

                if (minuteStats.count >= this.rateLimiter.limits.minute.max - 1) {
                    statsMessage += `⚠️ Dəqiqə limitinə yaxınlaşmısınız!\n`;
                }
                if (hourStats.count >= this.rateLimiter.limits.hour.max - 1) {
                    statsMessage += `⚠️ Saat limitinə yaxınlaşmısınız!\n`;
                }
                if (dayStats.count >= this.rateLimiter.limits.day.max - 1) {
                    statsMessage += `⚠️ Gün limitinə yaxınlaşmısınız!\n`;
                }

                await this.sendQuickReply(message, statsMessage);

                this.logger.info('📊 Rate limit statistikası göstərildi:', { user: userPhone }, 'system');

            } catch (error) {
                this.logger.error('❌ Rate limit statistikası xətası:', error, 'system');
                await this.sendQuickReply(message, '❌ Limit statistikaları gətirilərkən xəta baş verdi!');
            }
        });
    }

    // ADMIN KOMMANDALARI
    async handleBan(message) {
        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /ban <nömrə>');
            return;
        }

        try {
            const rawInput = parts[1];
            const normalized = this.normalizePhone(rawInput);

            if (!normalized) {
                await this.sendQuickReply(message, '❌ Nömrə düzgün formatda deyil!');
                return;
            }

            const existingBan = this.dataManager.isBanned(normalized);
            if (existingBan) {
                await this.sendQuickReply(
                    message,
                    `ℹ️ ${this.formatPhoneNumber(normalized)} artıq banlanmışdı.`
                );
                return;
            }

            this.dataManager.banUser(normalized);

            await this.sendQuickReply(
                message,
                `✅ ${this.formatPhoneNumber(normalized)} banlandı!`
            );

            this.logger.security(
                '🔨 İstifadəçi banlandı (normallaşdırılmış):',
                { phoneNumber: normalized },
                'security'
            );

        } catch (error) {
            this.logger.error('❌ Ban xətası:', error, 'security');
            await this.sendQuickReply(message, '❌ Ban edilərkən xəta baş verdi.');
        }
    }

    async handleUnban(message) {
        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /unban <nömrə>');
            return;
        }

        try {
            const rawInput = parts[1];
            const normalized = this.normalizePhone(rawInput);

            if (!normalized) {
                await this.sendQuickReply(message, '❌ Nömrə düzgün formatda deyil!');
                return;
            }

            const result = this.dataManager.unbanUser(normalized);

            if (result) {
                await this.sendQuickReply(
                    message,
                    `🔓 ${this.formatPhoneNumber(normalized)} unban edildi!`
                );

                this.logger.security(
                    '🔓 İstifadəçi unban edildi (normallaşdırılmış):',
                    { phoneNumber: normalized },
                    'security'
                );

            } else {
                await this.sendQuickReply(
                    message,
                    `❌ ${this.formatPhoneNumber(normalized)} ban siyahısında tapılmadı.`
                );
            }

        } catch (error) {
            this.logger.error('❌ Unban xətası:', error, 'security');
            await this.sendQuickReply(message, '❌ Unban edilərkən xəta baş verdi.');
        }
    }

    async handleListBan(message) {
        const bannedUsers = this.dataManager.getBannedUsers();

        if (bannedUsers.length === 0) {
            await this.sendQuickReply(message, 'ℹ️ Ban siyahısı boşdur.');
            return;
        }

        let banList = `🔨 BAN SİYAHISI (${bannedUsers.length} istifadəçi - normallaşdırılmış nömrələr):\n\n`;

        bannedUsers.forEach((user, index) => {
            const normalized = this.normalizePhone(user) || user;
            banList += `${index + 1}. ${normalized} (${this.formatPhoneNumber(normalized)})\n`;
        });

        await this.sendQuickReply(message, banList);

        this.logger.security(
            '📋 Ban siyahısı göstərildi (normallaşdırılmış)',
            { count: bannedUsers.length },
            'security'
        );
    }

    async handleAdminAdd(message) {
        const parts = message.body.split(' ');
        if (parts.length < 3) {
            await this.sendQuickReply(message, '❌ İstifadə: /admin add <nömrə>\nNümunə: /admin add 994506799917');
            return;
        }

        try {
            let phoneNumber = parts[2];

            if (!phoneNumber.includes('@c.us') && !phoneNumber.includes('@g.us')) {
                phoneNumber = phoneNumber + '@c.us';
            }

            const adminIds = this.dataManager.getAdmins();
            if (!adminIds.includes(phoneNumber)) {
                this.dataManager.addAdmin(phoneNumber);

                // Generate temp password for dashboard access
                const normalizedPhone = this.normalizePhone(phoneNumber);
                const tempPassword = await this.generateTempPassword(normalizedPhone);

                const formattedNumber = this.formatPhoneNumber(phoneNumber);

                // Notify command issuer
                await this.sendQuickReply(message,
                    `✅ ${formattedNumber} admin olaraq əlavə edildi!\n\n` +
                    `📱 Dashboard girişi üçün müvəqqəti şifrə göndərildi.`
                );

                // Send temp password to new admin
                try {
                    await this.client.sendMessage(phoneNumber,
                        `🎉 *ADNSU IT Dashboard Admin*\n\n` +
                        `Siz admin olaraq təyin edildiniz!\n\n` +
                        `📱 *Telefon:* ${formattedNumber}\n` +
                        `🔑 *Müvəqqəti şifrə:* \`${tempPassword}\`\n\n` +
                        `🌐 Dashboard: http://localhost:3000/login.html\n\n` +
                        `⚠️ İlk girişdə şifrənizi dəyişməlisiniz.`
                    );
                    this.logger.info(`📧 Temp password sent to ${formattedNumber}`, null, 'security');
                } catch (sendErr) {
                    this.logger.warn('Could not send temp password to new admin', sendErr, 'security');
                }

                this.logger.security('👮‍♂️ Yeni admin əlavə edildi:', { phoneNumber: phoneNumber }, 'security');
            } else {
                const formattedNumber = this.formatPhoneNumber(phoneNumber);
                await this.sendQuickReply(message, `ℹ️ ${formattedNumber} artıq admin idi.`);
            }

        } catch (error) {
            this.logger.error('❌ Admin əlavə etmə xətası:', error, 'security');
            await this.sendQuickReply(message, '❌ Admin əlavə edilərkən xəta baş verdi.');
        }
    }

    /**
     * Generate temp password for new admin
     * @param {string} phone - Phone number
     * @returns {Promise<string>} Temp password
     */
    async generateTempPassword(phone) {
        const crypto = require('crypto');
        const tempPass = crypto.randomBytes(4).toString('hex').toUpperCase();

        // Hash password
        let hash;
        try {
            const bcrypt = require('bcrypt');
            hash = await bcrypt.hash(tempPass, 12);
        } catch (e) {
            const salt = crypto.randomBytes(16).toString('hex');
            hash = salt + ':' + crypto.pbkdf2Sync(tempPass, salt, 100000, 64, 'sha512').toString('hex');
        }

        // Store with must_change = 1
        await this.db.run(
            `INSERT OR REPLACE INTO admin_passwords (phone, password_hash, must_change, created_at, updated_at) 
             VALUES (?, ?, 1, datetime('now'), datetime('now'))`,
            [phone, hash]
        );

        return tempPass;
    }

    async handleAdminRemove(message) {
        const parts = message.body.split(' ');
        if (parts.length < 3) {
            await this.sendQuickReply(message, '❌ İstifadə: /admin remove <nömrə>\nNümunə: /admin remove 994506799917');
            return;
        }

        try {
            let phoneNumber = parts[2];

            // Normalize the input phone
            const normalizedInput = this.normalizePhone(phoneNumber);
            if (!normalizedInput) {
                await this.sendQuickReply(message, '❌ Nömrə düzgün formatda deyil!');
                return;
            }

            // Find matching admin (with or without @c.us suffix)
            const adminIds = this.dataManager.getAdmins();
            let foundAdmin = null;

            for (const adminId of adminIds) {
                const normalizedAdmin = this.normalizePhone(adminId);
                if (normalizedAdmin === normalizedInput) {
                    foundAdmin = adminId;
                    break;
                }
            }

            if (foundAdmin) {
                this.dataManager.removeAdmin(foundAdmin);
                const formattedNumber = this.formatPhoneNumber(foundAdmin);
                await this.sendQuickReply(message, `✅ ${formattedNumber} admin siyahısından silindi!`);
                this.logger.security('👮‍♂️ Admin silindi:', { phoneNumber: foundAdmin }, 'security');
            } else {
                await this.sendQuickReply(message, `❌ ${normalizedInput} admin siyahısında tapılmadı.`);
            }

        } catch (error) {
            this.logger.error('❌ Admin silmə xətası:', error, 'security');
            await this.sendQuickReply(message, '❌ Admin silinərkən xəta baş verdi.');
        }
    }

    async handleAdminList(message) {
        const adminIds = this.dataManager.getAdmins();
        let adminList = `👮‍♂️ ADMIN SİYAHISI:\n\n`;

        if (adminIds.length > 0) {
            adminList += `📋 KONFİQURASİYA ADMİNLƏRİ:\n`;
            adminIds.forEach((adminId, index) => {
                const formattedNumber = this.formatPhoneNumber(adminId);
                adminList += `${index + 1}. ${formattedNumber}\n`;
            });
        } else {
            adminList += `❌ Konfiqurasiya admini yoxdur.\n`;
        }

        await this.sendQuickReply(message, adminList);

        this.logger.security('📋 Admin siyahısı göstərildi', { count: adminIds.length }, 'security');
    }

    // İSTİFADƏÇİ KOMMANDALARI
    async handleStop(message) {
        const userPhone = message.from;

        if (this.userStates.has(userPhone)) {
            this.userStates.delete(userPhone);
            await this.sendQuickReply(message, '🛑 Ticket prosesi dayandırıldı. Yenidən başlamaq üçün /start yazın.');

            this.logger.ticket('🛑 Ticket prosesi dayandırıldı:', { user: userPhone }, 'tickets');
        } else {
            await this.sendQuickReply(message, 'ℹ️ Hal-hazırda aktiv ticket prosesiniz yoxdur.');
        }
    }

    async handleIdShow(message) {
        const userPhone = message.from;
        const formattedNumber = this.formatPhoneNumber(userPhone);

        await this.sendQuickReply(message,
            `🆔 SİZİN ID-NİZ:\n\n` +
            `🔢 Tam ID: ${userPhone}\n` +
            `📞 Formatlı nömrə: ${formattedNumber}\n\n` +
            `Bu ID-ni admin əlavə etmək üçün istifadə edə bilərsiniz.\n` +
            `Admin: /admin add ${userPhone}`
        );

        this.logger.info('🆔 ID göstərildi:', { user: userPhone }, 'system');
    }

    async handleGroupId(message) {
        const groupId = message.from;

        // Qrup ID-ni config-ə saxla
        this.configManager.set('traineeGroupId', groupId);

        const response = `📋 QRUP MƏLUMATI:\n\n` +
            `🔢 ID: ${groupId}\n\n` +
            `✅ Qrup ID saxlandı! İndi ticketlar bu qrupa göndəriləcək.`;

        await this.sendQuickReply(message, response);

        this.logger.info('📋 Qrup ID saxlandı:', { groupId: groupId }, 'system');
    }

    async showHelp(message) {
        const helpText =
            `🎓 ADNSU IT BOT KOMANDALARI\n\n` +

            `🎫 TICKET İDARƏETMƏ:\n` +
            `📋 /list - Açıq ticketları göstər\n` +
            `⏳ /long list - Uzunmüddətli ticketlar\n` +
            `👤 /assign <id> - Ticketi öz üzərinə götür\n` +
            `🚫 /noassign <id> - Ticketdən imtina et\n` +
            `✅ /solved <id> <həll> - Ticketı həll et\n` +
            `⏰ /long <id> - Uzunmüddətli et\n` +
            `📸 /longphoto <id> - Uzunmüddətli ticketa şəkil əlavə et\n` +
            `♻️ /unsolved <id> - Solved olmuş ticketi geri açır\n` +
            `🔍 /find <söz> - Ticket axtar\n\n` +

            `📢 ƏLAVƏ KOMMANDALAR:\n` +
            `📝 /register <ad> - Adınızı qeydiyyatdan keçirin\n` +
            `📢 /announce <mesaj> - Qrupa elan göndər\n` +
            `🏓 /ping - Botun statusunu yoxla\n` +
            `⚡ /performance - Performans göstəriciləri\n` +
            `📊 /stats - Statistikanı göstər\n` +
            `📊 /logstats - Log statistikaları\n` +
            `📤 /mylimits - Ticket limitlərim\n\n` +

            `🔐ADMIN KOMANDALARI:\n` +
            `🔒 /ban <nömrə> - İstifadəçini banla\n` +
            `🔓 /unban <nömrə> - Banı aç\n` +
            `📋 /listban - Ban siyahısı\n` +
            `👮 /admin add <nömrə> - Admin əlavə et\n` +
            `👮 /admin remove <nömrə> - Admini sil\n` +
            `👮 /admin list - Admin siyahısı\n` +
            `📦 /logexport - Log fayllarını yüklə\n` +
            `📤 /export - Excel və PDF hesabatı çıxar\n` +
            `💾 /databaseexport - Database fayllarını zip-lə göndər\n` +
            `🔐 /login - Admin giriş\n` +
            `🚪 /logout - Admin çıxış\n\n` +

            `⚠️ QEYD: Admin komandaları yalnız şəxsi mesajda işləyir!\n\n` +

            `👤 İSTİFADƏÇİ KOMANDALARI:\n` +
            `▶️ /start - Ticket yaratma prosesi\n` +
            `🛑 /stop - Prosesi dayandır\n` +
            `🆔 /id - ID-nizi göstər\n` +
            `📅 /today - Bugünkü ticketlar\n\n` +

            `🔧 DİGƏR:\n` +
            `🆔 /groupid - Qrup ID-ni göstər\n` +
            `❓ /help - Kömək\n\n` +

            `📞 Şəxsi mesaj üçün:\n` +
            `🚀 /start - Yeni ticket başlat\n` +
            `🛑 /stop - Ticket prosesi dayandır\n` +
            `🆔 /id show - Öz ID-ni göstər\n` +
            `📊 /mylimits - Ticket limitlərim`;

        const messageParts = this.splitMessage(helpText, 4096);

        for (const part of messageParts) {
            await this.sendQuickReply(message, part);
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        this.logger.info('🆘 Yardım göstərildi', null, 'commands');
    }

    async handleRegister(message) {
        if (!message) return;

        // Check if DM
        if (message.from.endsWith('@g.us')) {
            await this.sendQuickReply(message, '❌ Bu komanda yalnız şəxsi söhbətdə işləyir.');
            return;
        }

        const parts = message.body.trim().split(/\s+/);
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /register <Adınız>');
            return;
        }

        const name = parts.slice(1).join(' '); // Allow names with spaces
        const phone = this.normalizePhone(message.from);

        try {
            await this.db.run(`INSERT OR REPLACE INTO admin_profiles (phone, name) VALUES (?, ?)`, [phone, name]);
            await this.sendQuickReply(message, `✅ Adınız "${name}" olaraq qeyd edildi.`);
            this.logger.info(`👤 Admin registered: ${phone} -> ${name}`, null, 'system');
        } catch (error) {
            this.logger.error('❌ Register error:', error, 'system');
            await this.sendQuickReply(message, '❌ Qeydiyyat zamanı xəta baş verdi.');
        }
    }

    async handleAssign(message) {
        if (!message) return;

        // Check if DM
        if (message.from.endsWith('@g.us')) {
            // Silently ignore or maybe reply? Prompt says "komanda kimi görməsin və cavab verməsin" for group checks if strictly interpreted, 
            // but user also said "cavabını qrupa yazsın". 
            // Let's follow "Ancaq şəxsidə işləyəcək" strictly for INPUT.
            return;
        }

        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /assign <ticket_id>');
            return;
        }

        const ticketId = parts[1];
        const adminPhone = this.normalizePhone(message.from);

        try {
            // Get Admin Name
            const adminProfile = await this.db.get(`SELECT name FROM admin_profiles WHERE phone = ?`, [adminPhone]);
            const adminName = adminProfile ? adminProfile.name : (message._data.notifyName || adminPhone);

            // [NEW] Check if admin already has an active ticket
            const activeTicket = await this.db.get(`
                SELECT id FROM tickets 
                WHERE assigned_admin = ? AND status NOT IN ('solved', 'long_term')
            `, [adminPhone]);

            if (activeTicket) {
                await this.sendQuickReply(message, `❌ Siz artıq Ticket #${activeTicket.id} ilə məşğulsunuz. Yeni ticket götürmək üçün əvvəlcə onu həll etməli (/solved) və ya imtina etməlisiniz (/noassign).`);
                return;
            }

            const ticket = await this.db.get(`SELECT * FROM tickets WHERE id = ?`, [ticketId]);

            if (!ticket) {
                await this.sendQuickReply(message, `❌ Ticket #${ticketId} tapılmadı.`);
                return;
            }

            if (ticket.status === 'solved') {
                await this.sendQuickReply(message, `❌ Ticket #${ticketId} artıq həll olunub.`);
                return;
            }

            if (ticket.status === 'long_term') {
                await this.sendQuickReply(message, `❌ Ticket #${ticketId} uzunmüddətli ticketdir. Assign olunmur.`);
                return;
            }

            if (ticket.assigned_admin) {
                if (ticket.assigned_admin === adminPhone) {
                    await this.sendQuickReply(message, `ℹ️ Bu ticket artıq sizdədir.`);
                } else {
                    const assignedProfile = await this.db.get(`SELECT name FROM admin_profiles WHERE phone = ?`, [ticket.assigned_admin]);
                    const assignedName = assignedProfile ? assignedProfile.name : ticket.assigned_admin;
                    await this.sendQuickReply(message, `❌ Bu ticket ilə artıq ${assignedName} məşğul olur.`);
                }
                return;
            }

            // Assign
            await this.db.run(
                `UPDATE tickets SET assigned_admin = ?, assigned_admin_name = ? WHERE id = ?`,
                [adminPhone, adminName, ticketId]
            );

            await this.sendQuickReply(message, `✅ Ticket #${ticketId} artıq sizin səlahiyyətinizdədir!`);

            // Notify Group
            const groupId = this.configManager.get('traineeGroupId');
            if (groupId) {
                await this.client.sendMessage(groupId, `👷 Ticket #${ticketId} ilə ${adminName} məşğul olur.`);
            }

            this.logger.info(`👤 Ticket assigned: #${ticketId} to ${adminName} (${adminPhone})`, null, 'tickets');

        } catch (error) {
            this.logger.error('❌ Assign error:', error, 'system');
            await this.sendQuickReply(message, '❌ Assign zamanı xəta baş verdi.');
        }
    }

    async handleNoAssign(message) {
        if (!message) return;

        // Check if DM
        if (message.from.endsWith('@g.us')) {
            return;
        }

        const parts = message.body.split(' ');
        if (parts.length < 2) {
            await this.sendQuickReply(message, '❌ İstifadə: /noassign <ticket_id>');
            return;
        }

        const ticketId = parts[1];
        const adminPhone = this.normalizePhone(message.from);

        try {
            // Get Admin Name for notification
            const adminProfile = await this.db.get(`SELECT name FROM admin_profiles WHERE phone = ?`, [adminPhone]);
            const adminName = adminProfile ? adminProfile.name : (message._data.notifyName || adminPhone);

            const ticket = await this.db.get(`SELECT * FROM tickets WHERE id = ?`, [ticketId]);

            if (!ticket) {
                await this.sendQuickReply(message, `❌ Ticket #${ticketId} tapılmadı.`);
                return;
            }

            if (ticket.assigned_admin !== adminPhone) {
                await this.sendQuickReply(message, `❌ Bu ticket sizə aid deyil.`);
                return;
            }

            if (ticket.status === 'solved') {
                await this.sendQuickReply(message, `ℹ️ Ticket artıq həll olunub, noassign etməyə ehtiyac yoxdur.`);
                return;
            }

            // Unassign
            await this.db.run(
                `UPDATE tickets SET assigned_admin = NULL, assigned_admin_name = NULL WHERE id = ?`,
                [ticketId]
            );

            await this.sendQuickReply(message, `✅ Ticket #${ticketId} artıq sizdə deyil.`);

            // Notify Group
            const groupId = this.configManager.get('traineeGroupId');
            if (groupId) {
                await this.client.sendMessage(groupId, `🔄 Ticket #${ticketId} ilə hal-hazırda heçkim məşqul olmur.(${adminName} imtina etdi).`);
            }

            this.logger.info(`👤 Ticket unassigned: #${ticketId} by ${adminName} (${adminPhone})`, null, 'tickets');

        } catch (error) {
            this.logger.error('❌ NoAssign error:', error, 'system');
            await this.sendQuickReply(message, '❌ NoAssign zamanı xəta baş verdi.');
        }

    }

    // KÖMƏKÇİ FUNKSİYALAR
    getBakuTime() {
        return moment().utcOffset(240);
    }

    formatPhoneNumber(phone) {
        if (!phone) return 'Nömrə yoxdur';

        const cleanPhone = phone.replace('@c.us', '').replace('+', '');

        if (cleanPhone.startsWith('994')) {
            const number = cleanPhone.substring(3);
            if (number.length === 9) {
                return `+994 ${number.substring(0, 2)} ${number.substring(2, 5)}-${number.substring(5, 7)}-${number.substring(7)}`;
            }
        }

        return `+${cleanPhone}`;
    }

    splitMessage(text, maxLength) {
        const messages = [];
        let currentMessage = '';

        const lines = text.split('\n');

        for (const line of lines) {
            if (currentMessage.length + line.length + 1 > maxLength) {
                messages.push(currentMessage);
                currentMessage = line + '\n';
            } else {
                currentMessage += line + '\n';
            }
        }

        if (currentMessage) {
            messages.push(currentMessage);
        }

        return messages;
    }

    async handleTicketError(message, userPhone, error) {
        this.logger.error('❌ Ticket xətası:', error, 'tickets');

        if (this.userStates.has(userPhone)) {
            const userState = this.userStates.get(userPhone);
            if (userState.attempts >= 3) {
                this.userStates.delete(userPhone);
                await this.sendQuickReply(message, '❌ Çox sayda səhv cəhd. Proses dayandırıldı. Yenidən başlamaq üçün /start yazın.');
            } else {
                await this.sendQuickReply(message, '❌ Xəta baş verdi. Zəhmət olmasa yenidən cəhd edin.');
            }
        }
    }

    // BOTU BAŞLATMAQ
    initialize() {
        this.logger.info('🚀 ADNSU IT Bot başladılır...', null, 'system');
        this.client.initialize();
    }
}

// ƏSAS PROSES
const bot = new ADNSUITBot();

// ✅ GLOBAL ERROR HANDLERS - Prevent bot crashes
process.on('unhandledRejection', (reason, promise) => {
    bot.logger.error('❌ Unhandled Rejection:', { reason, promise }, 'system');
    console.error('❌ Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    bot.logger.error('❌ Uncaught Exception:', error, 'system');
    console.error('❌ Uncaught Exception:', error);
    // Don't exit immediately, log and continue
});

// ✅ WhatsApp WebJS specific error handlers
bot.client.on('auth_failure', (msg) => {
    bot.logger.error('❌ Authentication failure:', msg, 'system');
    console.error('❌ Authentication failure:', msg);
});

bot.client.on('disconnected', (reason) => {
    bot.logger.warn('⚠️ WhatsApp disconnected:', { reason }, 'system');
    console.log('⚠️ WhatsApp disconnected:', reason);
    console.log('🔄 Attempting to reconnect...');
    // Auto-reconnect
    setTimeout(() => {
        bot.client.initialize();
    }, 5000);
});

bot.initialize();

// PERFORMANS MONITORING
setInterval(() => {
    const memoryUsage = process.memoryUsage();
    const logData = {
        rss: Math.round(memoryUsage.rss / 1024 / 1024),
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024),
        external: Math.round(memoryUsage.external / 1024 / 1024)
    };

    bot.logger.performance('Yaddaş monitorinqi', logData);

    if (memoryUsage.heapUsed > 500 * 1024 * 1024) {
        bot.logger.warn('⚠️ Yüksək yaddaş istifadəsi!', logData, 'performance');
    }
}, 300000);

// Graceful shutdown
process.on('SIGINT', async () => {
    bot.logger.info('🛑 Bot dayandırılır...', null, 'system');

    // Fetch final counts from DB
    const ticketCountResult = await bot.db.get('SELECT COUNT(*) AS count FROM tickets');

    const finalStats = {
        totalMessages: bot.performanceStats.totalMessages,
        averageResponseTime: bot.performanceStats.averageResponseTime.toFixed(2),
        slowOperations: bot.performanceStats.slowOperations,
        activeTickets: bot.userStates.size,
        totalTickets: ticketCountResult ? ticketCountResult.count : 0
    };

    console.log('📊 Son statistikalar:');
    console.log(`- Ümumi mesaj: ${finalStats.totalMessages}`);
    console.log(`- Orta cavab müddəti: ${finalStats.averageResponseTime}ms`);
    console.log(`- Yavaş əməliyyatlar: ${finalStats.slowOperations}`);
    console.log(`- Aktiv ticket prosesi: ${finalStats.activeTickets}`);
    console.log(`- Ümumi ticket: ${finalStats.totalTickets}`);

    // Log statistikalarını göstər
    const logStats = await bot.logger.getLogStats();
    console.log('📊 Log statistikaları:');
    for (const [category, count] of Object.entries(logStats)) {
        console.log(`- ${category}: ${count} log`);
    }

    if (bot.rateLimiter.cleanupInterval) {
        clearInterval(bot.rateLimiter.cleanupInterval);
    }
    if (bot.reminderInterval) {
        clearInterval(bot.reminderInterval);
    }

    // Close the database connection
    await bot.db.close();

    process.exit(0);
});

process.on('SIGTERM', async () => {
    bot.logger.info('🛑 Bot dayandırılır...', null, 'system');
    await bot.db.close();
    process.exit(0);
});