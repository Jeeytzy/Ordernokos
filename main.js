const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const fse = require('fs-extra');
const path = require('path');
const QRCode = require('qrcode');
const qs = require('querystring');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { EventEmitter } = require('events');

class AtomicFileManager {
    constructor() {
        this.writeQueue = new Map();
        this.locks = new Map();
    }

    async acquireLock(filePath) {
        const lockKey = path.resolve(filePath);
        while (this.locks.has(lockKey)) {
            await new Promise(resolve => setTimeout(resolve, 10));
        }
        this.locks.set(lockKey, true);
        return lockKey;
    }

    async releaseLock(lockKey) {
        this.locks.delete(lockKey);
    }

    async atomicWrite(filePath, data) {
        const lockKey = await this.acquireLock(filePath);
        try {
            const tempFile = `${filePath}.${Date.now()}.tmp`;
            await fs.writeFile(tempFile, JSON.stringify(data, null, 2));
            await fs.rename(tempFile, filePath);
        } finally {
            await this.releaseLock(lockKey);
        }
    }

    async atomicRead(filePath, defaultValue = null) {
        const lockKey = await this.acquireLock(filePath);
        try {
            try {
                const data = await fs.readFile(filePath, 'utf8');
                return JSON.parse(data);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return defaultValue;
                }
                throw error;
            }
        } finally {
            await this.releaseLock(lockKey);
        }
    }
}

class JobQueue {
    constructor(concurrency = 1) {
        this.queue = [];
        this.workers = [];
        this.running = 0;
        this.concurrency = concurrency;
        this.eventEmitter = new EventEmitter();
    }

    addJob(job) {
        this.queue.push(job);
        this.process();
    }

    async process() {
        if (this.running >= this.concurrency || this.queue.length === 0) {
            return;
        }

        this.running++;
        const job = this.queue.shift();

        try {
            const result = await job();
            this.eventEmitter.emit('completed', { job, result });
        } catch (error) {
            this.eventEmitter.emit('failed', { job, error });
        } finally {
            this.running--;
            this.process();
        }
    }

    on(event, listener) {
        this.eventEmitter.on(event, listener);
    }
}

class DatabaseManager {
    constructor() {
        this.fileManager = new AtomicFileManager();
        this.dataFile = 'data.json';
        this.ordersFile = 'orders.json';
        this.historyFile = 'history.json';
        this.topFile = 'top.json';
        this.userFile = 'user.json';
    }

    async loadUsers() {
        return await this.fileManager.atomicRead(this.dataFile, []);
    }

    async saveUsers(users) {
        await this.fileManager.atomicWrite(this.dataFile, users);
    }

    async loadOrders() {
        return await this.fileManager.atomicRead(this.ordersFile, {});
    }

    async saveOrders(orders) {
        await this.fileManager.atomicWrite(this.ordersFile, orders);
    }

    async loadHistory() {
        return await this.fileManager.atomicRead(this.historyFile, {});
    }

    async saveHistory(history) {
        await this.fileManager.atomicWrite(this.historyFile, history);
    }

    async loadTop() {
        return await this.fileManager.atomicRead(this.topFile, []);
    }

    async saveTop(top) {
        await this.fileManager.atomicWrite(this.topFile, top);
    }

    async loadBroadcastUsers() {
        return await this.fileManager.atomicRead(this.userFile, []);
    }

    async saveBroadcastUsers(users) {
        await this.fileManager.atomicWrite(this.userFile, users);
    }
}

async function editPhotoCaption(bot, chatId, msgId, photoUrl, text, keyboard) {
  try {
    return await bot.editMessageCaption(text, {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  } catch (e) {
    if (e.response?.body?.description?.includes("can't be edited")) {
      try { await bot.deleteMessage(chatId, msgId); } catch (_) {}
      return await bot.sendPhoto(chatId, photoUrl, {
        caption: text,
        reply_markup: keyboard,
        parse_mode: 'Markdown'
      });
    }
    throw e;
  }
}

class VirtuSIMBot {
    constructor() {
        this.config = {
            BOT_TOKEN: '8493786090:AAH4VxtRTMFU6lhHwnEBVOeaBFnXV5vPGG8',
            VIRTUSIM_API_KEY: 'PoRuVqUIzE5mwF38sC9cf60krtvHJY',
            API_BASE_URL: 'https://virtusim.com/api/v2/json.php',
            MARKUP_PROFIT: 2000,
            MAX_CHECK_ATTEMPTS: 20,
            CIAATOPUP_API_KEY: 'CiaaTopUp_61c141rrxlhep5b6',
            CIAATOPUP_BASE_URL: 'https://ciaatopup.my.id',
            TESTIMONI_CHANNEL: '@MarketplaceclCretatorID',
            OWNER_ID: 7804463533
        };

        this.countryFlags = {
            'Russia': '🇷🇺',
            'Ukraine': '🇺🇦',
            'Kazakhstan': '🇰🇿',
            'China': '🇨🇳',
            'Philippines': '🇵🇭',
            'Myanmar': '🇲🇲',
            'Indonesia': '🇮🇩',
            'Malaysia': '🇲🇾',
            'Kenya': '🇰🇪',
            'Tanzania': '🇹🇿',
            'Vietnam': '🇻🇳',
            'Kyrgyzstan': '🇰🇬',
            'USA': '🇺🇸',
            'Israel': '🇮🇱',
            'HongKong': '🇭🇰',
            'Poland': '🇵🇱',
            'England': '🇬🇧',
            'Madagascar': '🇲🇬',
            'Congo': '🇨🇩',
            'Nigeria': '🇳🇬',
            'Macau': '🇲🇴',
            'Egypt': '🇪🇬',
            'India': '🇮🇳',
            'Ireland': '🇮🇪',
            'Cameroon': '🇨🇲',
            'SriLanka': '🇱🇰',
            'SierraLeone': '🇸🇱',
            'Slovenia': '🇸🇮',
            'Slovakia': '🇸🇰',
            'Austria': '🇦🇹',
            'Sweden': '🇸🇪',
            'CzechRepublic': '🇨🇿',
            'Eritrea': '🇪🇷',
            'Estonia': '🇪🇪',
            'Tajikistan': '🇹🇯',
            'Thailand': '🇹🇭',
            'Tunisia': '🇹🇳',
            'Turkey': '🇹🇷',
            'Uganda': '🇺🇬',
            'Uzbekistan': '🇺🇿',
            'Finland': '🇫🇮',
            'France': '🇫🇷',
            'Haiti': '🇭🇹',
            'Croatia': '🇭🇷',
            'Chad': '🇹🇩',
            'Montenegro': '🇲🇪',
            'Switzerland': '🇨🇭',
            'Ecuador': '🇪🇨',
            'Ethiopia': '🇪🇹',
            'SouthAfrica': '🇿🇦',
            'Jamaica': '🇯🇲',
            'Japan': '🇯🇵',
            'SouthKorea': '🇰🇷',
            'Albania': '🇦🇱',
            'Algeria': '🇩🇿',
            'Argentina': '🇦🇷',
            'Armenia': '🇦🇲',
            'Azerbaijan': '🇦🇿',
            'Bahrain': '🇧🇭',
            'Bangladesh': '🇧🇩',
            'Belgium': '🇧🇪',
            'Belize': '🇧🇿',
            'Bolivia': '🇧🇴',
            'BosniaAndHerzegovina': '🇧🇦',
            'Brazil': '🇧🇷',
            'Bulgaria': '🇧🇬',
            'BurkinaFaso': '🇧🇫',
            'Burundi': '🇧🇮',
            'Cambodia': '🇰🇭',
            'Canada': '🇨🇦',
            'Chile': '🇨🇱',
            'Colombia': '🇨🇴',
            'CostaRica': '🇨🇷',
            'Cyprus': '🇨🇾',
            'Denmark': '🇩🇰',
            'DominicanRepublic': '🇩🇴',
            'ElSalvador': '🇸🇻',
            'Georgia': '🇬🇪',
            'Germany': '🇩🇪',
            'Ghana': '🇬🇭',
            'Greece': '🇬🇷',
            'Guatemala': '🇬🇹',
            'Guinea': '🇬🇳',
            'GuineaBissau': '🇬🇼',
            'Guyana': '🇬🇾',
            'Honduras': '🇭🇳',
            'Hungary': '🇭🇺',
            'Iceland': '🇮🇸',
            'Iran': '🇮🇷',
            'Iraq': '🇮🇶',
            'Italy': '🇮🇹',
            'IvoryCoast': '🇨🇮',
            'Jordan': '🇯🇴',
            'Kuwait': '🇰🇼',
            'Laos': '🇱🇦',
            'Latvia': '🇱🇻',
            'Lebanon': '🇱🇧',
            'Lesotho': '🇱🇸',
            'Liberia': '🇱🇷',
            'Libya': '🇱🇾',
            'Lithuania': '🇱🇹',
            'Luxembourg': '🇱🇺',
            'Macedonia': '🇲🇰',
            'Malawi': '🇲🇼',
            'Mali': '🇲🇱',
            'Malta': '🇲🇹',
            'Mauritania': '🇲🇷',
            'Mauritius': '🇲🇺',
            'Mexico': '🇲🇽',
            'Moldova': '🇲🇩',
            'Mongolia': '🇲🇳',
            'Morocco': '🇲🇦',
            'Mozambique': '🇲🇿',
            'Namibia': '🇳🇦',
            'Nepal': '🇳🇵',
            'Netherlands': '🇳🇱',
            'NewZealand': '🇳🇿',
            'Nicaragua': '🇳🇮',
            'Niger': '🇳🇪',
            'Norway': '🇳🇴',
            'Oman': '🇴🇲',
            'Pakistan': '🇵🇰',
            'Panama': '🇵🇦',
            'PapuaNewGuinea': '🇵🇬',
            'Paraguay': '🇵🇾',
            'Peru': '🇵🇪',
            'Portugal': '🇵🇹',
            'PuertoRico': '🇵🇷',
            'Qatar': '🇶🇦',
            'Reunion': '🇷🇪',
            'Romania': '🇷🇴',
            'Rwanda': '🇷🇼',
            'SaudiArabia': '🇸🇦',
            'Senegal': '🇸🇳',
            'Serbia': '🇷🇸',
            'Seychelles': '🇸🇨',
            'Singapore': '🇸🇬',
            'Somalia': '🇸🇴',
            'Spain': '🇪🇸',
            'Sudan': '🇸🇩',
            'Suriname': '🇸🇷',
            'Swaziland': '🇸🇿',
            'Syria': '🇸🇾',
            'Taiwan': '🇹🇼',
            'Togo': '🇹🇬',
            'TrinidadAndTobago': '🇹🇹',
            'UAE': '🇦🇪',
            'Uruguay': '🇺🇾',
            'Venezuela': '🇻🇪',
            'Yemen': '🇾🇪',
            'Zambia': '🇿🇲',
            'Zimbabwe': '🇿🇼',
            'Afghanistan': '🇦🇫',
            'Angola': '🇦🇴',
            'Anguilla': '🇦🇮',
            'AntiguaAndBarbuda': '🇦🇬',
            'Aruba': '🇦🇼',
            'Australia': '🇦🇺',
            'Bahamas': '🇧🇸',
            'Barbados': '🇧🇧',
            'Benin': '🇧🇯',
            'Bermuda': '🇧🇲',
            'Bhutan': '🇧🇹',
            'Botswana': '🇧🇼',
            'BritishVirginIslands': '🇻🇬',
            'Brunei': '🇧🇳',
            'CapeVerde': '🇨🇻',
            'CaymanIslands': '🇰🇾',
            'CentralAfricanRepublic': '🇨🇫',
            'Comoros': '🇰🇲',
            'CookIslands': '🇨🇰',
            'Cuba': '🇨🇺',
            'Curacao': '🇨🇼',
            'Djibouti': '🇩🇯',
            'Dominica': '🇩🇲',
            'EastTimor': '🇹🇱',
            'EquatorialGuinea': '🇬🇶',
            'FaroeIslands': '🇫🇴',
            'Fiji': '🇫🇯',
            'FrenchGuiana': '🇬🇫',
            'FrenchPolynesia': '🇵🇫',
            'Gabon': '🇬🇦',
            'Gambia': '🇬🇲',
            'Gibraltar': '🇬🇮',
            'Greenland': '🇬🇱',
            'Grenada': '🇬🇩',
            'Guadeloupe': '🇬🇵',
            'Guam': '🇬🇺',
            'Kiribati': '🇰🇮',
            'Kosovo': '🇽🇰',
            'Liechtenstein': '🇱🇮',
            'Maldives': '🇲🇻',
            'Martinique': '🇲🇶',
            'Mayotte': '🇾🇹',
            'Micronesia': '🇫🇲',
            'Monaco': '🇲🇨',
            'Montserrat': '🇲🇸',
            'Nauru': '🇳🇷',
            'NewCaledonia': '🇳🇨',
            'Niue': '🇳🇺',
            'NorthKorea': '🇰🇵',
            'NorthernMarianaIslands': '🇲🇵',
            'Palau': '🇵🇼',
            'Palestine': '🇵🇸',
            'Samoa': '🇼🇸',
            'SanMarino': '🇸🇲',
            'SaoTomeAndPrincipe': '🇸🇹',
            'SolomonIslands': '🇸🇧',
            'SouthSudan': '🇸🇸',
            'StKittsAndNevis': '🇰🇳',
            'StLucia': '🇱🇨',
            'StVincentAndTheGrenadines': '🇻🇨',
            'Tonga': '🇹🇴',
            'Turkmenistan': '🇹🇲',
            'TurksAndCaicosIslands': '🇹🇨',
            'Tuvalu': '🇹🇻',
            'USVirginIslands': '🇻🇮',
            'Vanuatu': '🇻🇺',
            'VaticanCity': '🇻🇦',
            'WallisAndFutuna': '🇼🇫',
            'WesternSahara': '🇪🇭'
        };

        this.bot = new TelegramBot(this.config.BOT_TOKEN, { 
            polling: true,
            filepath: false
        });
        
        const originalEditMessageText = this.bot.editMessageText;
        this.bot.editMessageText = async function(text, options) {
            try {
                return await originalEditMessageText.call(this, text, options);
            } catch (error) {
                if (error.response?.body?.description?.includes('message is not modified')) {
                    return;
                }
                throw error;
            }
        };
        
        this.processingCallbacks = new Set();
        this.botLogo = 'https://files.catbox.moe/9pivb2.jpg';
        this.db = new DatabaseManager();
        this.jobQueue = new JobQueue(5);
        this.activeMonitors = new Map();
        this.userLocks = new Map();
        this.pendingOrders = new Set();
        this.refundLocks = new Set();
        this.autoPending = [];

        this.setupErrorHandling();
        this.setupHandlers();
        this.startDepositMonitoring();
        this.startCleanupWorker();

        console.log('🤖 VirtuSIM Bot started with enhanced architecture!');
    }

    getCountryFlag(countryName) {
        return this.countryFlags[countryName] || '🌍';
    }

    setupErrorHandling() {
        process.on('unhandledRejection', (reason, promise) => {
            console.error('Unhandled Rejection at:', promise, 'reason:', reason);
        });

        process.on('uncaughtException', (error) => {
            console.error('Uncaught Exception:', error);
        });

        this.jobQueue.on('failed', ({ job, error }) => {
            console.error('Job failed:', error);
        });
    }

    setupHandlers() {
        this.bot.onText(/\/start/, (msg) => this.jobQueue.addJob(() => this.handleStart(msg)));
        this.bot.onText(/\/del (\d+)/, (msg, match) => this.jobQueue.addJob(() => this.handleDelete(msg, match)));
        this.bot.onText(/\/info (\d+)/, (msg, match) => this.jobQueue.addJob(() => this.handleInfo(msg, match)));
        this.bot.onText(/\/deposit(?: (\d+))?/, (msg, match) => this.jobQueue.addJob(() => this.handleDeposit(msg, match)));
        this.bot.onText(/\/reff (\d+) (\d+)/, (msg, match) => this.jobQueue.addJob(() => this.handleReffCommand(msg, match)));
        this.bot.onText(/\/bc (.+)/s, (msg, match) => this.jobQueue.addJob(() => this.handleBroadcast(msg, match)));
        
        this.bot.on('callback_query', (query) => this.jobQueue.addJob(() => this.handleCallback(query)));
        
        this.bot.on('photo', (msg) => {
            if (msg.caption && msg.caption.startsWith('/bc ')) {
                this.jobQueue.addJob(() => this.handlePhotoBroadcast(msg));
            }
        });
    }

    async sendPhotoMessage(chatId, text, keyboard, deleteMessageId = null) {
        if (deleteMessageId) {
            try {
                await this.bot.deleteMessage(chatId, deleteMessageId);
            } catch (error) {
                console.log('Cannot delete message:', error.message);
            }
        }
        
        return await this.bot.sendPhoto(chatId, this.botLogo, {
            caption: text,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }

    async handleStart(msg) {
        if (msg.chat.type !== 'private') {
            return this.bot.sendMessage(msg.chat.id, "⚠️ Bot ini hanya bekerja di private chat.");
        }
        
        const userId = msg.from.id;
        await this.addUserToBroadcastList(userId);
        const user = await this.getUser(userId);
       
        const uniqueUsers = await this.loadUniqueUsers();
        const usersWithBalance = await this.getUsersWithBalance();

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📱 Beli Nomor SMS', callback_data: 'buy_start' },
                    { text: '💰 Cek Saldo', callback_data: 'check_balance' }
                ],
                [
                    { text: '📋 Pesanan Aktif', callback_data: 'active_orders' },
                    { text: '📜 Riwayat Order', callback_data: 'order_history' }
                ],
                [
                    { text: '💳 Top Up', callback_data: 'topup' },
                    { text: '🏆 Top Users', callback_data: 'top_users' }
                ],
                [
                    { text: '📜 Syarat & Ketentuan', callback_data: 'rules' },
                    { text: 'ℹ️ Bantuan', callback_data: 'help' }
                ]
            ]
        };

        if (userId === this.config.OWNER_ID) {
            keyboard.inline_keyboard.push([
                { text: '👑 Owner Panel', callback_data: 'owner_panel' }
            ]);
        }

        const timeInfo = this.getIndonesianTime();
        const saldoDisplay = user ? user.saldo.toLocaleString('id-ID') : '0';
        const sanitizeName = (name) => {
            if (!name) return 'Tidak ada';
            return name.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        };
        
        const username = msg.from.username ? '@' + sanitizeName(msg.from.username) : 'Tidak ada';
        
        const welcomeText = user ? 
            `\`\`\`👋 Selamat Datang Kembali!\n\nHalo ${msg.from.first_name}! Senang melihat Anda lagi.\n\n` :
            `🌟 Selamat Datang di bot auto order\n\nHalo ${msg.from.first_name}! Selamat bergabung.\n\n`;
        
        const fullText = welcomeText +
            `👤 Info Akun:\n` +
             `Username: ${username}\n` +
            `ID: \`${userId}\`\n` +
            `📅 Tanggal: ${timeInfo.date}\n` +
            `🕐 Jam: ${timeInfo.time}\n\n` +
            `💰 Saldo: Rp ${saldoDisplay}\n\n` +
            `📊 Statistik Bot:\n` +
            `👥 Total User: ${uniqueUsers.length}\n` +
            `💳 Total User Deposit: ${usersWithBalance.length}\n\n` +
            `🤖 *Fitur Otomatis:*\n` +
            `✅ Beli nomor instan\n` +
            `✅ Terima SMS otomatis\n` +
            `✅ Selesai otomatis\n` +
            `✅ Refund otomatis jika gagal\n\n` +
            `⚠️ *DISCLAIMER:*\n` +
            `• Bot tidak bertanggung jawab jika OTP sudah dikirim ke chat ini\n` +
            `• Saldo yang ada di bot TIDAK BISA di-refund\n\n` +
            `👨‍💻 Bot Developer: @Jeeyhosting\n\n` +
            `Pilih menu di bawah\`\`\`:`;

        await this.bot.sendPhoto(msg.chat.id, this.botLogo, {
            caption: fullText,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }

    async handleCallback(query) {
        const chatId = query.message.chat.id;
        const messageId = query.message.message_id;
        const data = query.data;
        const userId = query.from.id;
        const callbackKey = `${chatId}_${messageId}_${data}`;

        if (this.processingCallbacks.has(callbackKey)) {
            await this.bot.answerCallbackQuery(query.id, {
                text: "Sedang memproses, tunggu...",
                show_alert: false
            });
            return; 
        }

        this.processingCallbacks.add(callbackKey);
        await this.bot.answerCallbackQuery(query.id);

        try {
            const handlers = {
                'top_users': () => this.showTopUsers(chatId, messageId),
                'top_saldo': () => this.showTopSaldo(chatId, messageId),
                'top_orders': () => this.showTopOrders(chatId, messageId),
                'buy_start': () => this.showCountries(chatId, messageId),
                'check_balance': () => this.checkBalance(chatId, messageId, userId),
                'active_orders': () => this.showActiveOrders(chatId, messageId, userId),
                'order_history': () => this.showOrderHistory(chatId, messageId, userId),
                'topup': () => this.showTopup(chatId, messageId),
                'help': () => this.showHelp(chatId, messageId),
                'rules': () => this.showRules(chatId, messageId),
                'owner_panel': () => this.showOwnerPanel(chatId, messageId, userId),
                'owner_stats': () => this.showOwnerStats(chatId, messageId, userId),
                'owner_saldo': () => this.showOwnerSaldo(chatId, messageId, userId),
                'owner_orders': () => this.showOwnerOrders(chatId, messageId, userId),
                'back_main': () => this.showMainMenu(chatId, messageId, userId)
            };

            if (data.startsWith('countries_page_')) {
                const page = parseInt(data.replace('countries_page_', ''));
                await this.showCountries(chatId, messageId, page);
            } else if (data.startsWith('country_')) {
                await this.showServices(chatId, messageId, data);
            } else if (data.startsWith('service_')) {
                await this.confirmPurchase(chatId, messageId, data, userId);
            } else if (data.startsWith('buy_confirm_')) {
                await this.processPurchase(chatId, messageId, data, userId);
            } else if (data.startsWith('cancel_')) {
                if (data === 'cancel_processing') {
                    await this.bot.answerCallbackQuery(query.id, { 
                        text: 'Sedang memproses pembatalan, harap tunggu...', 
                        show_alert: true 
                    });
                } else if (data === 'cancel_wait_5_minutes') {
                    await this.bot.answerCallbackQuery(query.id, { 
                        text: 'Button cancel akan muncul dalam 5 menit setelah order. Silakan tunggu.', 
                        show_alert: true 
                    });
                } else if (data.startsWith('cancel_deposit_')) {
                    await this.cancelDeposit(query);
                } else {
                    await this.cancelOrder(chatId, messageId, data, userId);
                }
            } else if (handlers[data]) {
                await handlers[data]();
            } else if (data === 'page_info') {
                return;
            } else {
                console.log(`Unknown callback data: ${data}`);
                await this.bot.sendMessage(chatId, `\`\`\`❌ Command tidak dikenal: "${data}"\nSilakan /start ulang.\`\`\``);
            }
        } catch (error) {
            console.error(`Callback error for data "${data}":`, error);
            await this.bot.sendMessage(chatId, 
                `\`\`\`❌ Terjadi Masalah Sistem\n\nSilakan ketik /start untuk memulai ulang.\`\`\``,
                { parse_mode: 'Markdown' }
            );
        } finally {
            this.processingCallbacks.delete(callbackKey);
        }
    }

    async handleBroadcast(msg, match) {
        const senderId = msg.from.id;
        const chatId = msg.chat.id;

        if (senderId !== this.config.OWNER_ID) {
        console.log(`⚠️ Unauthorized broadcast attempt from user ${senderId}`);
            return this.bot.sendMessage(chatId, 
                "❌ *Access Denied*\n\nCommand ini hanya untuk owner bot.", 
                { parse_mode: 'Markdown' }
            );
        }

        const broadcastText = match[1];
        
        if (!broadcastText || broadcastText.trim().length === 0) {
            return this.bot.sendMessage(chatId, 
                "❌ *Format Salah*\n\n" +
                "**Teks Only:** `/bc Teks panjang bisa multi line`\n" +
                "**Foto + Caption:** Upload foto dengan caption `/bc Caption text`", 
                { parse_mode: 'Markdown' }
            );
        }

        const sanitizedText = broadcastText.replace(/[<>]/g, '');

        try {
            const users = await this.loadUniqueUsers();
            
            if (users.length === 0) {
                return this.bot.sendMessage(chatId, 
                    "❌ *Tidak Ada User*\n\nBelum ada user yang /start bot.", 
                    { parse_mode: 'Markdown' }
                );
            }

            console.log(`📡 Owner ${senderId} starting broadcast to ${users.length} users`);

            if (msg.photo && msg.photo.length > 0) {
                await this.broadcastWithPhoto(chatId, msg, sanitizedText, users);
            } else {
                await this.broadcastTextOnly(chatId, sanitizedText, users);
            }

        } catch (error) {
            console.error('Broadcast error:', error);
            await this.bot.sendMessage(chatId, 
                "❌ *Error Sistem*\n\nTerjadi kesalahan saat broadcast.", 
                { parse_mode: 'Markdown' }
            );
        }
    }

    async handlePhotoBroadcast(msg) {
        const senderId = msg.from.id;
        const chatId = msg.chat.id;

        if (senderId !== this.config.OWNER_ID) {
            return this.bot.sendMessage(chatId, 
                "❌ *Access Denied*\n\nCommand ini hanya untuk owner bot.", 
                { parse_mode: 'Markdown' }
            );
        }

        const broadcastText = msg.caption.replace('/bc ', '');
        
        if (!broadcastText || broadcastText.trim().length === 0) {
            return this.bot.sendMessage(chatId, 
                "❌ *Format Salah*\n\nCaption tidak boleh kosong.", 
                { parse_mode: 'Markdown' }
            );
        }

        const sanitizedText = broadcastText.replace(/[<>]/g, '');

        try {
            const users = await this.loadUniqueUsers();
            
            if (users.length === 0) {
                return this.bot.sendMessage(chatId, 
                    "❌ *Tidak Ada User*\n\nBelum ada user yang /start bot.", 
                    { parse_mode: 'Markdown' }
                );
            }

            await this.broadcastWithPhoto(chatId, msg, sanitizedText, users);

        } catch (error) {
            console.error('Photo broadcast error:', error);
            await this.bot.sendMessage(chatId, 
                "❌ *Error Sistem*\n\nTerjadi kesalahan saat broadcast.", 
                { parse_mode: 'Markdown' }
            );
        }
    }

    async broadcastTextOnly(chatId, text, users) {
        let successCount = 0;
        let failCount = 0;
        const totalUsers = users.length;

        const progressMsg = await this.bot.sendMessage(chatId, 
            `📡 *Broadcasting Text...*\n\n` +
            `📊 Target: ${totalUsers} users\n` +
            `✅ Berhasil: 0\n` +
            `❌ Gagal: 0\n` +
            `⏳ Progress: 0%`,
            { parse_mode: 'Markdown' }
        );

        for (let i = 0; i < users.length; i++) {
            const userId = users[i];
            
            if (userId < 0 && Math.abs(userId) > 1000000000000) {
                failCount++;
                continue;
            }
            
            try {
                await this.bot.sendMessage(userId, text, { parse_mode: 'Markdown' });
                successCount++;
            } catch (error) {
                failCount++;
            }

            if ((i + 1) % 10 === 0 || i === users.length - 1) {
                const progress = Math.round(((i + 1) / totalUsers) * 100);
                
                try {
                    await this.bot.editMessageText(
                        `📡 *Broadcasting Text...*\n\n` +
                        `📊 Target: ${totalUsers} users\n` +
                        `✅ Berhasil: ${successCount}\n` +
                        `❌ Gagal: ${failCount}\n` +
                        `⏳ Progress: ${progress}%`,
                        {
                            chat_id: chatId,
                            message_id: progressMsg.message_id,
                            parse_mode: 'Markdown'
                        }
                    );
                } catch (editError) {
                }
            }

            await new Promise(resolve => setTimeout(resolve, 50));
        }

        const timeInfo = this.getIndonesianTime();
        const finalText = `✅ *Broadcast Selesai!*\n\n` +
            `📊 **Laporan:**\n` +
            `👥 Total Target: ${totalUsers}\n` +
            `✅ Berhasil Terkirim: ${successCount}\n` +
            `❌ Gagal Terkirim: ${failCount}\n` +
            `📈 Success Rate: ${Math.round((successCount/totalUsers)*100)}%\n\n` +
            `📅 Tanggal: ${timeInfo.date}\n` +
            `🕐 Jam: ${timeInfo.time}`;

        await this.bot.editMessageText(finalText, {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown'
        });
    }

    async broadcastWithPhoto(chatId, originalMsg, caption, users) {
        let successCount = 0;
        let failCount = 0;
        const totalUsers = users.length;

        const photos = originalMsg.photo;
        const largestPhoto = photos[photos.length - 1];
        const photoId = largestPhoto.file_id;

        const progressMsg = await this.bot.sendMessage(chatId, 
            `📡 *Broadcasting Photo + Caption...*\n\n` +
            `📊 Target: ${totalUsers} users\n` +
            `✅ Berhasil: 0\n` +
            `❌ Gagal: 0\n` +
            `⏳ Progress: 0%`,
            { parse_mode: 'Markdown' }
        );

        for (let i = 0; i < users.length; i++) {
            const userId = users[i];
            
            if (userId < 0 && Math.abs(userId) > 1000000000000) {
                failCount++;
                continue;
            }
            
            try {
                await this.bot.sendPhoto(userId, photoId, {
                    caption: caption,
                    parse_mode: 'Markdown'
                });
                successCount++;
            } catch (error) {
                failCount++;
            }

            if ((i + 1) % 5 === 0 || i === users.length - 1) {
                const progress = Math.round(((i + 1) / totalUsers) * 100);
                
                try {
                    await this.bot.editMessageText(
                        `📡 *Broadcasting Photo + Caption...*\n\n` +
                        `📊 Target: ${totalUsers} users\n` +
                        `✅ Berhasil: ${successCount}\n` +
                        `❌ Gagal: ${failCount}\n` +
                        `⏳ Progress: ${progress}%`,
                        {
                            chat_id: chatId,
                            message_id: progressMsg.message_id,
                            parse_mode: 'Markdown'
                        }
                    );
                } catch (editError) {
                }
            }

            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const finalText = `✅ *Broadcast Foto Selesai!*\n\n` +
            `📊 **Laporan:**\n` +
            `👥 Total Target: ${totalUsers}\n` +
            `✅ Berhasil Terkirim: ${successCount}\n` +
            `❌ Gagal Terkirim: ${failCount}\n` +
            `📈 Success Rate: ${Math.round((successCount/totalUsers)*100)}%\n\n` +
            `🕐 Waktu: ${new Date().toLocaleString('id-ID')}`;

        await this.bot.editMessageText(finalText, {
            chat_id: chatId,
            message_id: progressMsg.message_id,
            parse_mode: 'Markdown'
        });
    }

    async handleReffCommand(msg, match) {
        const senderId = msg.from.id;
        const targetUserId = match[1];
        const amount = parseInt(match[2]);

        if (senderId !== this.config.OWNER_ID) {
            return this.bot.sendMessage(msg.chat.id, 
                "❌ *Access Denied*\n\nCommand ini hanya untuk owner bot.", 
                { parse_mode: 'Markdown' }
            );
        }

        if (!amount || amount < 100) {
            return this.bot.sendMessage(msg.chat.id, 
                "❌ *Invalid Amount*\n\nMinimal Rp 100\nContoh: `/reff 123456789 5000`", 
                { parse_mode: 'Markdown' }
            );
        }

        try {
            const timestamp = this.getIndonesianTimestamp();
            const users = await this.db.loadUsers();
            const userIndex = users.findIndex(user => user.id === targetUserId.toString());
            
            if (userIndex !== -1) {
                const oldSaldo = users[userIndex].saldo;
                users[userIndex].saldo += amount;
                users[userIndex].date = timestamp;
                
                await this.db.saveUsers(users);

                const ownerText = `✅ *Reffund Berhasil!*\n\n` +
                    `👤 Target User ID: \`${targetUserId}\`\n` +
                    `💰 Jumlah: Rp ${amount.toLocaleString('id-ID')}\n` +
                    `📊 Saldo Lama: Rp ${oldSaldo.toLocaleString('id-ID')}\n` +
                    `📊 Saldo Baru: Rp ${users[userIndex].saldo.toLocaleString('id-ID')}\n` +
                    `📅 Waktu: ${timestamp}`;

                await this.bot.sendMessage(msg.chat.id, ownerText, { parse_mode: 'Markdown' });

            } else {
                const newUser = {
                    id: targetUserId.toString(),
                    saldo: amount,
                    date: timestamp
                };
                users.push(newUser);
                await this.db.saveUsers(users);

                const ownerText = `✅ *Reffund Berhasil! (User Baru)*\n\n` +
                    `👤 Target User ID: \`${targetUserId}\`\n` +
                    `💰 Jumlah: Rp ${amount.toLocaleString('id-ID')}\n` +
                    `📊 Saldo: Rp ${amount.toLocaleString('id-ID')}\n` +
                    `📅 Waktu: ${timestamp}`;

                await this.bot.sendMessage(msg.chat.id, ownerText, { parse_mode: 'Markdown' });
            }

            try {
                const userText = `🎉 *Selamat! Saldo Anda Bertambah*\n\n` +
                    `💰 Anda mendapat saldo Rp ${amount.toLocaleString('id-ID')}\n` +
                    `💳 Saldo total: Rp ${users.find(u => u.id === targetUserId.toString()).saldo.toLocaleString('id-ID')}\n\n` +
                    `🎁 Dari: Admin Bot\n` +
                    `📅 Waktu: ${timestamp}\n\n` +
                    `Gunakan saldo untuk beli nomor SMS!`;

                await this.bot.sendMessage(targetUserId, userText, { parse_mode: 'Markdown' });
                
                await this.bot.sendMessage(msg.chat.id, 
                    `📨 Notifikasi berhasil dikirim ke user ${targetUserId}`
                );
            } catch (notifError) {
                await this.bot.sendMessage(msg.chat.id, 
                    `⚠️ Saldo berhasil ditambah, tapi gagal kirim notifikasi ke user`
                );
            }

        } catch (error) {
            console.error('Referral command error:', error);
            await this.bot.sendMessage(msg.chat.id, 
                "❌ *System Error*\n\nTerjadi kesalahan saat memproses referral."
            );
        }
    }

    async apiRequest(action, params = {}) {
        try {
            const url = new URL(this.config.API_BASE_URL);
            url.searchParams.append('api_key', this.config.VIRTUSIM_API_KEY);
            url.searchParams.append('action', action);
            
            Object.entries(params).forEach(([key, value]) => {
                url.searchParams.append(key, value);
            });

            const response = await axios.get(url.toString(), { timeout: 30000 });
            return response.data;
        } catch (error) {
            console.error(`API Error (${action}):`, error.message);
            return null;
        }
    }

    async ciaaTopUpRequest(endpoint, params = {}) {
        try {
            const url = `${this.config.CIAATOPUP_BASE_URL}${endpoint}`;
            const queryParams = new URLSearchParams(params).toString();
            const fullUrl = queryParams ? `${url}?${queryParams}` : url;

            const response = await axios.get(fullUrl, {
                headers: {
                    'X-APIKEY': this.config.CIAATOPUP_API_KEY,
                    'Content-Type': 'application/json'
                },
                timeout: 30000
            });

            return response.data;
        } catch (error) {
            console.error(`CiaaTopUp API Error (${endpoint}):`, error.message);
            if (error.response) {
                return error.response.data;
            }
            return null;
        }
    }

    async showTopUsers(chatId, messageId) {
        try {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '💰 Top Saldo', callback_data: 'top_saldo' }],
                    [{ text: '📦 Top Orders', callback_data: 'top_orders' }],
                    [{ text: '🔙 Menu Utama', callback_data: 'back_main' }]
                ]
            };

            const topText = `🏆 *TOP USERS*\n\n` +
                `Pilih kategori yang ingin dilihat:\n\n` +
                `💰 **Top Saldo** - User dengan saldo terbesar\n` +
                `📦 **Top Orders** - User dengan order terbanyak\n\n` +
                `📊 Data diupdate real-time`;

            await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, topText, keyboard);

        } catch (error) {
            console.error('Show top users error:', error);
            await this.bot.editMessageText('❌ Error loading top users data', {
                chat_id: chatId,
                message_id: messageId
            });
        }
    }

    async showTopSaldo(chatId, messageId) {
        try {
            const users = await this.db.loadUsers();
            const topSaldo = users
                .filter(user => user.saldo > 0)
                .sort((a, b) => b.saldo - a.saldo)
                .slice(0, 10);

            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔄 Refresh', callback_data: 'top_saldo' }],
                    [{ text: '🔙 Top Users', callback_data: 'top_users' }]
                ]
            };

            let saldoText = 'TOP SALDO USER\n\n';
            
            if (topSaldo.length > 0) {
                topSaldo.forEach((user, index) => {
                    const hiddenId = user.id.substring(0, 4) + 'xxx' + user.id.substring(user.id.length - 3);
                    const safeDate = String(user.date || 'Unknown').substring(0, 19);
                    
                    saldoText += (index + 1) + '. ID: ' + hiddenId + '\n';
                    saldoText += '   Saldo: Rp ' + user.saldo.toLocaleString('id-ID') + '\n';
                    saldoText += '   Tanggal: ' + safeDate + '\n\n';
                });
            } else {
                saldoText += 'Belum ada user dengan saldo.\n\n';
            }
            
            const timeInfo = this.getIndonesianTime();
            saldoText += 'Update: ' + timeInfo.date + ' ' + timeInfo.time;

            await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, saldoText, keyboard);

        } catch (error) {
            console.error('Show top saldo error:', error);
            
            const errorKeyboard = {
                inline_keyboard: [[{ text: '🔙 Top Users', callback_data: 'top_users' }]]
            };
            
            await this.bot.editMessageText('Error loading top saldo. Silakan coba lagi', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: errorKeyboard
            });
        }
    }

    async showTopOrders(chatId, messageId) {
        try {
            const history = await this.db.loadHistory();
            
            const userOrderCounts = {};
            
            Object.keys(history).forEach(userIdStr => {
                const userOrders = history[userIdStr];
                if (userOrders && userOrders.length > 0) {
                    userOrderCounts[userIdStr] = {
                        count: userOrders.length,
                        totalSpent: userOrders.reduce((sum, order) => sum + (order.price || 0), 0)
                    };
                }
            });

            const topOrders = Object.entries(userOrderCounts)
                .sort(([,a], [,b]) => b.count - a.count)
                .slice(0, 10);

            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔄 Refresh', callback_data: 'top_orders' }],
                    [{ text: '🔙 Top Users', callback_data: 'top_users' }]
                ]
            };

            const totalCustomers = Object.keys(history).length;
            const totalOrders = Object.values(history).reduce((sum, orders) => sum + orders.length, 0);
            const totalRevenue = Object.values(history).reduce((sum, orders) => {
                return sum + orders.reduce((orderSum, order) => orderSum + (order.price || 0), 0);
            }, 0);

            let ordersText = `📦 TOP ORDERS USER\n\n`;
            
            ordersText += `📊 Statistik:\n`;
            ordersText += `👥 Total Customers: ${totalCustomers}\n`;
            ordersText += `📋 Total Orders: ${totalOrders}\n`;
            ordersText += `💵 Total Revenue: Rp ${totalRevenue.toLocaleString('id-ID')}\n\n`;
            
            if (topOrders.length > 0) {
                ordersText += `🏆 Top 10 Customer:\n\n`;
                
                for (let index = 0; index < topOrders.length; index++) {
                    const [userIdStr, data] = topOrders[index];
                    const medal = index < 3 ? ['🥇', '🥈', '🥉'][index] : `${index + 1}.`;
                    const hiddenId = userIdStr.substring(0, 4) + "xxx" + userIdStr.substring(userIdStr.length - 3);
                    
                    ordersText += `${medal} ID: ${hiddenId}\n`;
                    ordersText += `    📦 Total order: ${data.count}\n`;
                    ordersText += `    💰 Total spent: Rp ${data.totalSpent.toLocaleString('id-ID')}\n\n`;
                    
                    if (ordersText.length > 3500) {
                        ordersText += `... dan ${topOrders.length - index - 1} customer lainnya\n\n`;
                        break;
                    }
                }
                
            } else {
                ordersText += `🔍 Belum ada data order.\n\n`;
            }
            
            const now = new Date();
            const jakartaTime = now.toLocaleString('id-ID', {
                timeZone: 'Asia/Jakarta',
                year: 'numeric',
                month: '2-digit', 
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
                hour12: false
            });
            
            ordersText += `🕐 Update: ${jakartaTime} WIB`;

            if (ordersText.length > 4000) {
                ordersText = ordersText.substring(0, 3900) + "\n\n... (data terpotong)";
            }

            await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, ordersText, keyboard);

        } catch (error) {
            console.error('Show top orders error:', error);
            
            const errorKeyboard = {
                inline_keyboard: [
                    [{ text: '🔙 Top Users', callback_data: 'top_users' }]
                ]
            };
            
            try {
                await this.bot.editMessageText(
                    '❌ Error loading data\n\nData terlalu besar atau corrupt, hubungi admin @Jeeyhosting', 
                    {
                        chat_id: chatId,
                        message_id: messageId,
                        reply_markup: errorKeyboard
                    }
                );
            } catch (fallbackError) {
                console.error('Fallback error message failed:', fallbackError);
            }
        }
    }

    async showOwnerPanel(chatId, messageId, userId) {
        if (userId !== this.config.OWNER_ID) {
            await this.bot.editMessageText('❌ Access Denied', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        const users = await this.db.loadUsers();
        const orders = await this.db.loadOrders();
        const broadcastUsers = await this.db.loadBroadcastUsers();
        const totalUsers = users.length;
        const totalBroadcastUsers = broadcastUsers.length;
        const totalSaldo = users.reduce((sum, user) => sum + user.saldo, 0);
        const activeOrders = Object.keys(orders).length;

        const keyboard = {
            inline_keyboard: [
                [{ text: '📊 User Statistics', callback_data: 'owner_stats' }],
                [{ text: '💰 Saldo Management', callback_data: 'owner_saldo' }],
                [{ text: '📋 Active Orders', callback_data: 'owner_orders' }],
                [{ text: '🔙 Main Menu', callback_data: 'back_main' }]
            ]
        };

        const timeInfo = this.getIndonesianTime();

        const ownerText = `\`\`\`👑 OWNER KONTROL\n\n` +
            `📊 *Bot Statistics:*\n` +
            `👥 Total Users: ${totalUsers}\n` +
            `📡 Broadcast Users: ${totalBroadcastUsers}\n` +
            `💰 Total Saldo: Rp ${totalSaldo.toLocaleString('id-ID')}\n` +
            `📋 Active Orders: ${activeOrders}\n` +
            `📅 Tanggal: ${timeInfo.date}\n` +
            `🕐 Jam: ${timeInfo.time}\n\n` +
            `🔐 Owner Commands:\n` +
            `\`/reff USER_ID AMOUNT\` - Add saldo to user\n` +
            `\`/bc TEXT\` - Broadcast text only\n` +
            `Upload foto + \`/bc CAPTION\` - Broadcast foto + caption\n\n` +
            `💡 *Broadcast Examples:*\n` +
            `\`/bc Halo semuanya!\nBot maintenance 5 menit\nTerima kasih\`\n\n` +
            `Upload foto lalu caption:\n` +
            `\`/bc Promo hari ini!\nDiskon 50%\`\n\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, ownerText, keyboard);
    }

    async showOwnerStats(chatId, messageId, userId) {
        if (userId !== this.config.OWNER_ID) {
            await this.bot.editMessageText('❌ Access Denied', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        const users = await this.db.loadUsers();
        const broadcastUsers = await this.db.loadBroadcastUsers();
        
        const totalUsers = users.length;
        const usersWithBalance = users.filter(u => u.saldo > 0).length;
        const totalSaldo = users.reduce((sum, user) => sum + user.saldo, 0);
        const avgSaldo = totalUsers > 0 ? Math.round(totalSaldo / totalUsers) : 0;
        
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentUsers = users.filter(u => {
            if (!u.joinDate) return false;
            return new Date(u.joinDate) > weekAgo;
        }).length;

        const keyboard = {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'owner_stats' }],
                [{ text: '🔙 Owner Panel', callback_data: 'owner_panel' }]
            ]
        };

        const timeInfo = this.getIndonesianTime();

        const statsText = `\`\`\`📊 USER STATISTICS\n\n` +
            `👥 Total Users: ${totalUsers}\n` +
            `📡 Broadcast List: ${broadcastUsers.length}\n` +
            `💰 Users with Balance: ${usersWithBalance}\n` +
            `💎 Total Saldo: Rp ${totalSaldo.toLocaleString('id-ID')}\n` +
            `📈 Average Saldo: Rp ${avgSaldo.toLocaleString('id-ID')}\n` +
            `🆕 New Users (7 days): ${recentUsers}\n\n` +
            `📅 Tanggal: ${timeInfo.date}\n` +
            `🕐 Jam: ${timeInfo.time}\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, statsText, keyboard);
    }

    async showOwnerSaldo(chatId, messageId, userId) {
        if (userId !== this.config.OWNER_ID) {
            await this.bot.editMessageText('❌ Access Denied', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        const users = await this.db.loadUsers();
        
        const topUsers = users
            .filter(u => u.saldo > 0)
            .sort((a, b) => b.saldo - a.saldo)
            .slice(0, 10);

        const keyboard = {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'owner_saldo' }],
                [{ text: '🔙 Owner Panel', callback_data: 'owner_panel' }]
            ]
        };

        let saldoText = `💰 *SALDO MANAGEMENT*\n\n`;
        
        if (topUsers.length > 0) {
            saldoText += `💎 *Top ${topUsers.length} Users by Balance:*\n\n`;
            topUsers.forEach((user, index) => {
                saldoText += `${index + 1}. ID: \`${user.id}\` - Rp ${user.saldo.toLocaleString('id-ID')}\n`;
            });
        } else {
            saldoText += `🔍 *No users with balance found.*\n`;
        }
        
        saldoText += `\n🔐 *Commands:*\n`;
        saldoText += `\`/reff USER_ID AMOUNT\` - Add saldo\n\n`;
        
        const timeInfo = this.getIndonesianTime();
        saldoText += `📅 Tanggal: ${timeInfo.date}\n🕐 Jam: ${timeInfo.time}`;
        
        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, saldoText, keyboard);
    }

    async showOwnerOrders(chatId, messageId, userId) {
        if (userId !== this.config.OWNER_ID) {
            await this.bot.editMessageText('❌ Access Denied', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        const orders = await this.db.loadOrders();
        const activeOrders = Object.keys(orders);

        const keyboard = {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'owner_orders' }],
                [{ text: '🔙 Owner Panel', callback_data: 'owner_panel' }]
            ]
        };

        let ordersText = `📋 *ACTIVE ORDERS MANAGEMENT*\n\n`;
        
        if (activeOrders.length > 0) {
            ordersText += `🔥 *Active Orders: ${activeOrders.length}*\n\n`;
            
            activeOrders.slice(0, 10).forEach((userIdKey, index) => {
                const order = orders[userIdKey];
                const elapsed = Math.floor((Date.now() - order.timestamp) / 60000);
                ordersText += `${index + 1}. User: \`${userIdKey}\`\n`;
                ordersText += `   Service: ${order.serviceName}\n`;
                ordersText += `   Number: +${order.number}\n`;
                ordersText += `   Price: Rp ${order.price.toLocaleString('id-ID')}\n`;
                ordersText += `   Time: ${elapsed} min ago\n\n`;
            });
            
            if (activeOrders.length > 10) {
                ordersText += `... dan ${activeOrders.length - 10} orders lainnya\n\n`;
            }
        } else {
            ordersText += `✅ *No active orders*\n\n`;
        }
        
        const timeInfo = this.getIndonesianTime();
        ordersText += `📅 Tanggal: ${timeInfo.date}\n🕐 Jam: ${timeInfo.time}`;
        
        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, ordersText, keyboard);
    }

    async showCountries(chatId, messageId, page = 0) {
        const countriesData = await this.apiRequest('list_country');
        
        if (!countriesData || !countriesData.status) {
            const errorKeyboard = {
                inline_keyboard: [
                    [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                ]
            };

            const originalError = countriesData?.data?.msg || countriesData?.message || 'Gagal mengambil data negara dari provider';
            
            const errorText = `\`\`\`❌ *Gagal Mengambil Data Negara*\n\n` +
                `🔄 *Respon Error:*\n` +
                `${originalError}\`\`\``;

            await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, errorText, errorKeyboard);
            return;
        }

        const ITEMS_PER_PAGE = 10;
        const totalPages = Math.ceil(countriesData.data.length / ITEMS_PER_PAGE);
        const startIndex = page * ITEMS_PER_PAGE;
        const endIndex = startIndex + ITEMS_PER_PAGE;
        const countriesOnPage = countriesData.data.slice(startIndex, endIndex);

        const keyboard = {
            inline_keyboard: []
        };

        countriesOnPage.forEach(country => {
            const flag = this.getCountryFlag(country.country_name);
            keyboard.inline_keyboard.push([{
                text: `${flag} ${country.country_name}`,
                callback_data: `country_${country.country_name}_page_0`
            }]);
        });

        const navButtons = [];
        
        if (page > 0) {
            navButtons.push({
                text: '⬅️ Sebelumnya',
                callback_data: `countries_page_${page - 1}`
            });
        }
        
        navButtons.push({
            text: `${page + 1}/${totalPages}`,
            callback_data: 'page_info'
        });
        
        if (page < totalPages - 1) {
            navButtons.push({
                text: 'Berikutnya ➡️',
                callback_data: `countries_page_${page + 1}`
            });
        }
        
        if (navButtons.length > 0) {
            keyboard.inline_keyboard.push(navButtons);
        }

        keyboard.inline_keyboard.push([{ text: '🔙 Menu Utama', callback_data: 'back_main' }]);

        const headerText = `\`\`\` 🌍 *Pilih Negara* (Hal ${page + 1}/${totalPages})\n\n` +
            `Total ${countriesData.data.length} negara tersedia.\n` +
            `Pilih negara untuk nomor SMS: \`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, headerText, keyboard);
    }

    async showServices(chatId, messageId, data) {
        const dataParts = data.replace('country_', '').split('_page_');
        const country = dataParts[0];
        const currentPage = parseInt(dataParts[1] || '0');
        
        const servicesData = await this.apiRequest('services', { country });
        
        if (!servicesData || !servicesData.status) {
            const errorKeyboard = {
                inline_keyboard: [
                    [{ text: '🔙 Pilih Negara', callback_data: 'buy_start' }],
                    [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                ]
            };

            const originalError = servicesData?.data?.msg || servicesData?.message || 'Gagal mengambil data layanan dari provider';
            
            const errorText = `❌ *Gagal Mengambil Data Layanan*\n\n` +
                `🔄 *Respon Error:*\n` +
                `${originalError}`;

            await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, errorText, errorKeyboard);
            return;
        }

        const availableServices = servicesData.data.filter(service => parseInt(service.tersedia) > 0);
        
        if (availableServices.length === 0) {
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔙 Pilih Negara', callback_data: 'buy_start' }],
                    [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                ]
            };
            
            await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, `\`\`\`❌ *Stock Habis di ${country}*\n\nSilakan pilih negara lain atau coba lagi nanti.\`\`\``, keyboard);
            return;
        }

        const uniqueServicesMap = new Map();
        
        availableServices.forEach(service => {
            const normalizedName = service.name.toLowerCase().trim();
            
            if (!uniqueServicesMap.has(normalizedName)) {
                uniqueServicesMap.set(normalizedName, service);
            } else {
                const existing = uniqueServicesMap.get(normalizedName);
                const existingStock = parseInt(existing.tersedia);
                const newStock = parseInt(service.tersedia);
                const existingPrice = parseInt(existing.price);
                const newPrice = parseInt(service.price);
                
                if (newStock > existingStock || (newStock === existingStock && newPrice < existingPrice)) {
                    uniqueServicesMap.set(normalizedName, service);
                }
            }
        });
        
        const uniqueServices = Array.from(uniqueServicesMap.values());

        const priorityServices = uniqueServices.sort((a, b) => {
            const getPriority = (service) => {
                const name = service.name.toLowerCase();
                
                if (name.includes('whatsapp')) return 1;
                if (name.includes('viber')) return 2;
                if (name.includes('telegram')) return 3;
                if (name.includes('instagram')) return 4;
                if (name.includes('facebook')) return 5;
                if (name.includes('twitter') || name.includes(' x ') || name === 'x') return 6;
                if (name.includes('tiktok')) return 7;
                if (name.includes('discord')) return 8;
                if (name.includes('google')) return 9;
                if (name.includes('yahoo')) return 10;
                if (name.includes('microsoft')) return 11;
                if (name.includes('linkedin')) return 12;
                if (name.includes('snapchat')) return 13;
                
                return 999;
            };
            
            const priorityA = getPriority(a);
            const priorityB = getPriority(b);
            
            if (priorityA !== priorityB) {
                return priorityA - priorityB;
            }
            
            const stockA = parseInt(a.tersedia);
            const stockB = parseInt(b.tersedia);
            if (stockA !== stockB) {
                return stockB - stockA;
            }
            
            const priceA = parseInt(a.price);
            const priceB = parseInt(b.price);
            return priceA - priceB;
        });

        const ITEMS_PER_PAGE = 8;
        const totalPages = Math.ceil(priorityServices.length / ITEMS_PER_PAGE);
        const startIndex = currentPage * ITEMS_PER_PAGE;
        const endIndex = startIndex + ITEMS_PER_PAGE;
        const servicesOnPage = priorityServices.slice(startIndex, endIndex);

        const keyboard = {
            inline_keyboard: []
        };

        servicesOnPage.forEach(service => {
            const price = parseInt(service.price) + this.config.MARKUP_PROFIT;
            const name = service.name.toLowerCase();
            
            let emoji = '📱';
            if (name.includes('whatsapp')) emoji = '🔥';
            else if (name.includes('viber')) emoji = '🔥';
            else if (name.includes('telegram')) emoji = '🔥';
            else if (name.includes('instagram')) emoji = '📸';
            else if (name.includes('facebook')) emoji = '📘';
            else if (name.includes('twitter') || name.includes(' x ')) emoji = '🦅';
            else if (name.includes('tiktok')) emoji = '🎵';
            else if (name.includes('discord')) emoji = '🎮';
            else if (name.includes('google')) emoji = '🔎';
            
            const text = `${emoji} ${service.name.toUpperCase()} - Rp ${price.toLocaleString('id-ID')} | Stok: ${service.tersedia}`;
            keyboard.inline_keyboard.push([{
                text,
                callback_data: `service_${service.id}_${country}_${price}_${service.name.replace(/\s/g, '_')}`
            }]);
        });

        const navButtons = [];
        
        if (currentPage > 0) {
            navButtons.push({
                text: '⬅️ Sebelumnya',
                callback_data: `country_${country}_page_${currentPage - 1}`
            });
        }
        
        navButtons.push({
            text: `${currentPage + 1}/${totalPages}`,
            callback_data: 'page_info'
        });
        
        if (currentPage < totalPages - 1) {
            navButtons.push({
                text: 'Berikutnya ➡️',
                callback_data: `country_${country}_page_${currentPage + 1}`
            });
        }
        
        if (navButtons.length > 0) {
            keyboard.inline_keyboard.push(navButtons);
        }

        keyboard.inline_keyboard.push([{ text: '🔙 Pilih Negara', callback_data: 'buy_start' }]);

        const countryFlag = this.getCountryFlag(country);
        const headerText = `${countryFlag} *Layanan di ${country}* (Hal ${currentPage + 1}/${totalPages})\n\n` +
            `Total ${priorityServices.length} layanan tersedia.\n` +
            `📌 WhatsApp & Viber diprioritaskan di atas.\n` +
            `Pilih layanan yang dibutuhkan:`;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, headerText, keyboard);
    }

    async confirmPurchase(chatId, messageId, data, userId) {
        const dataParts = data.split('_');
        const serviceId = dataParts[1];
        const country = dataParts[2];
        const price = parseInt(dataParts[3]);
        const serviceName = dataParts.slice(4).join('_').replace(/_/g, ' ');
        
        const user = await this.getUser(userId);

        if (!user || user.saldo < price) {
           const currentSaldo = user ? user.saldo : 0;
           const keyboard = {
                inline_keyboard: [[{ text: '💳 Top Up Saldo', callback_data: 'topup' }]]
           };
    
           await editPhotoCaption(
           this.bot,
           chatId,
           messageId,
           this.botLogo,
           `❌ *Saldo Tidak Cukup*\n\n` +
           `Saldo Anda: Rp ${currentSaldo.toLocaleString('id-ID')}\n` +
           `Dibutuhkan: Rp ${price.toLocaleString('id-ID')}\n` +
           `Kurang: Rp ${(price - currentSaldo).toLocaleString('id-ID')}`,
           keyboard
           );

        return;
      }

        const keyboard = {
            inline_keyboard: [
                [{ text: '✅ Beli Sekarang', callback_data: `buy_confirm_${serviceId}_${country}_${price}_${serviceName.replace(/\s/g, '_')}` }],
                [{ text: '🔙 Kembali', callback_data: `country_${country}_page_0` }]
            ]
        };

        const countryFlag = this.getCountryFlag(country);
        const confirmText = `\`\`\`📱 *Konfirmasi Pembelian*\n\n` +
            `📧 Layanan: ${serviceName}\n` +
            `${countryFlag} Negara: ${country}\n` +
            `💰 Harga: Rp ${price.toLocaleString('id-ID')}\n` +
            `💳 Saldo Anda: Rp ${user.saldo.toLocaleString('id-ID')}\n\n` +
            `🤖 *Proses Otomatis:*\n` +
            `✅ Dapat nomor langsung\n` +
            `✅ SMS masuk otomatis dikirim\n` +
            `✅ Refund jika gagal dalam 5 menit\n\n` +
            `Lanjutkan pembelian?\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, confirmText, keyboard);
    }
    
    async handleDelete(msg, match) {
    const senderId = msg.from.id;
    const chatId = msg.chat.id;
    const targetUserId = match[1];

    if (senderId !== this.config.OWNER_ID) {
        return this.bot.sendMessage(chatId, 
            "❌ *Access Denied*\n\nCommand ini hanya untuk owner bot.", 
            { parse_mode: 'Markdown' }
        );
    }

    try {
        const users = await this.db.loadUsers();
        const userIndex = users.findIndex(u => u.id === targetUserId.toString());

        if (userIndex === -1) {
            return this.bot.sendMessage(chatId,
                `❌ *User Tidak Ditemukan*\n\nUser ID: \`${targetUserId}\` tidak ada di database.`,
                { parse_mode: 'Markdown' }
            );
        }

        const deletedUser = users[userIndex];
        
        const orders = await this.db.loadOrders();
        const hasActiveOrder = orders[targetUserId];
        
        if (hasActiveOrder) {
            if (this.activeMonitors.has(targetUserId)) {
                clearInterval(this.activeMonitors.get(targetUserId));
                this.activeMonitors.delete(targetUserId);
            }
            
            try {
                await this.apiRequest('set_status', { id: hasActiveOrder.orderId, status: '2' });
            } catch (e) {}
            
            delete orders[targetUserId];
            await this.db.saveOrders(orders);
        }

        users.splice(userIndex, 1);
        await this.db.saveUsers(users);

        const timeInfo = this.getIndonesianTime();

        await this.bot.sendMessage(chatId,
            `✅ *User Berhasil Dihapus*\n\n` +
            `🆔 ID: \`${targetUserId}\`\n` +
            `💰 Saldo Terhapus: Rp ${deletedUser.saldo.toLocaleString('id-ID')}\n` +
            `📅 Tanggal Join: ${deletedUser.date || 'N/A'}\n` +
            `📦 Order Aktif: ${hasActiveOrder ? 'Dibatalkan' : 'Tidak ada'}\n` +
            `🕐 Dihapus: ${timeInfo.date} ${timeInfo.time}\n\n` +
            `Data user telah dihapus dari data.json`,
            { parse_mode: 'Markdown' }
        );

        try {
            await this.bot.sendMessage(targetUserId,
                `⚠️ *Akun Anda Telah Dihapus*\n\n` +
                `Admin telah menghapus akun Anda dari sistem.\n` +
                `Ketik /start untuk daftar ulang.`,
                { parse_mode: 'Markdown' }
            );
        } catch (notifError) {
            console.log(`Cannot notify deleted user ${targetUserId}`);
        }

    } catch (error) {
        console.error('Delete user error:', error);
        await this.bot.sendMessage(chatId,
            `❌ *System Error*\n\nGagal menghapus user.`,
            { parse_mode: 'Markdown' }
        );
    }
}

    async handleInfo(msg, match) {
        const senderId = msg.from.id;
        const chatId = msg.chat.id;
        const targetUserId = match[1];

        if (senderId !== this.config.OWNER_ID) {
            return this.bot.sendMessage(chatId, 
                "❌ *Access Denied*\n\nCommand ini hanya untuk owner bot.", 
                { parse_mode: 'Markdown' }
            );
        }

        try {
            const users = await this.db.loadUsers();
            const user = users.find(u => u.id === targetUserId.toString());

            if (!user) {
                return this.bot.sendMessage(chatId,
                    `❌ *User Tidak Ditemukan*\n\nUser ID: \`${targetUserId}\` tidak ada di database.`,
                    { parse_mode: 'Markdown' }
                );
            }

            const orders = await this.db.loadOrders();
            const hasActiveOrder = orders[targetUserId] ? 'Ya' : 'Tidak';
            const activeOrderInfo = orders[targetUserId] ? 
                `\n📋 Order Aktif:\n` +
                `   Nomor: +${orders[targetUserId].number}\n` +
                `   Layanan: ${orders[targetUserId].serviceName}\n` +
                `   Harga: Rp ${orders[targetUserId].price.toLocaleString('id-ID')}\n` +
                `   Order ID: ${orders[targetUserId].orderId}` : '';

            const history = await this.db.loadHistory();
            const userHistory = history[targetUserId] || [];
            const totalOrders = userHistory.length;
            const totalSpent = userHistory.reduce((sum, order) => sum + (order.price || 0), 0);

            let userInfo = `👤 *INFO USER*\n\n` +
                `🆔 ID: \`${targetUserId}\`\n` +
                `💰 Saldo: Rp ${user.saldo.toLocaleString('id-ID')}\n` +
                `📅 Tanggal Join: ${user.date || 'N/A'}\n` +
                `📦 Pesanan Aktif: ${hasActiveOrder}${activeOrderInfo}\n\n` +
                `📊 *Statistik:*\n` +
                `📋 Total Order Selesai: ${totalOrders}\n` +
                `💵 Total Pengeluaran: Rp ${totalSpent.toLocaleString('id-ID')}\n`;

            if (totalOrders > 0) {
                const lastOrder = userHistory[0];
                userInfo += `\n🕐 *Order Terakhir:*\n` +
                    `   Layanan: ${lastOrder.serviceName}\n` +
                    `   Negara: ${lastOrder.country}\n` +
                    `   Harga: Rp ${lastOrder.price.toLocaleString('id-ID')}\n` +
                    `   Waktu: ${lastOrder.completedAt}`;
            }

            try {
                const chatInfo = await this.bot.getChat(targetUserId);
                const username = chatInfo.username ? `@${chatInfo.username}` : 'Tidak ada';
                const fullName = chatInfo.first_name + (chatInfo.last_name ? ` ${chatInfo.last_name}` : '');
                
                userInfo = `👤 *INFO USER*\n\n` +
                    `🆔 ID: \`${targetUserId}\`\n` +
                    `👤 Nama: ${fullName}\n` +
                    `📱 Username: ${username}\n` +
                    `💰 Saldo: Rp ${user.saldo.toLocaleString('id-ID')}\n` +
                    `📅 Tanggal Join: ${user.date || 'N/A'}\n` +
                    `📦 Pesanan Aktif: ${hasActiveOrder}${activeOrderInfo}\n\n` +
                    `📊 *Statistik:*\n` +
                    `📋 Total Order Selesai: ${totalOrders}\n` +
                    `💵 Total Pengeluaran: Rp ${totalSpent.toLocaleString('id-ID')}\n`;

                if (totalOrders > 0) {
                    const lastOrder = userHistory[0];
                    userInfo += `\n🕐 *Order Terakhir:*\n` +
                        `   Layanan: ${lastOrder.serviceName}\n` +
                        `   Negara: ${lastOrder.country}\n` +
                        `   Harga: Rp ${lastOrder.price.toLocaleString('id-ID')}\n` +
                        `   Waktu: ${lastOrder.completedAt}`;
                }
            } catch (chatError) {
                console.log(`Cannot get chat info for ${targetUserId}`);
            }

            await this.bot.sendMessage(chatId, userInfo, { parse_mode: 'Markdown' });

        } catch (error) {
            console.error('Info user error:', error);
            await this.bot.sendMessage(chatId,
                `❌ *System Error*\n\nGagal mengambil info user.`,
                { parse_mode: 'Markdown' }
            );
        }
    }

    async processPurchase(chatId, messageId, data, userId) {
        const dataParts = data.replace('buy_confirm_', '').split('_');
        const serviceId = dataParts[0];
        const country = dataParts[1];
        const oldPrice = parseInt(dataParts[2]);
        const serviceName = dataParts.slice(3).join('_').replace(/_/g, ' ');

        const orders = await this.db.loadOrders();
        if (orders[userId]) {
            await editPhotoCaption(
                this.bot,
                chatId,
                messageId,
                this.botLogo,
                '❌ Anda masih memiliki pesanan aktif. Selesaikan dulu atau batalkan.',
                { inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'back_main' }]] }  
            );
            return;
        }

        const processingKey = `processing_${userId}`;
        if (this.pendingOrders.has(processingKey)) {
            await editPhotoCaption(
                this.bot,
                chatId,
                messageId,
                this.botLogo,
                '⏳ Pesanan Anda sedang diproses. Harap tunggu...',
                { inline_keyboard: [] }
            );
            return;
        }

        this.pendingOrders.add(processingKey);

        try {
            await editPhotoCaption(
                this.bot,
                chatId,
                messageId,
                this.botLogo,
                '⏳ Mengecek harga terbaru...\n\nHarap tunggu, jangan tekan apapun.',
                { inline_keyboard: [] }
            );

            const servicesData = await this.apiRequest('services', { country });
            
            if (!servicesData || !servicesData.status) {
                this.pendingOrders.delete(processingKey);
                const errorKeyboard = {
                    inline_keyboard: [
                        [{ text: '🔙 Kembali', callback_data: `country_${country}_page_0` }],
                        [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                    ]
                };
                await editPhotoCaption(
                    this.bot,
                    chatId,
                    messageId,
                    this.botLogo,
                    '❌ Gagal mengecek harga terbaru. Coba lagi.',
                    errorKeyboard
                );
                return;
            }

            const service = servicesData.data.find(s => s.id === serviceId);
            
            if (!service || parseInt(service.tersedia) === 0) {
                this.pendingOrders.delete(processingKey);
                const errorKeyboard = {
                    inline_keyboard: [
                        [{ text: '🔙 Pilih Layanan Lain', callback_data: `country_${country}_page_0` }],
                        [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                    ]
                };
                await editPhotoCaption(
                    this.bot,
                    chatId,
                    messageId,
                    this.botLogo,
                    '❌ Stock habis untuk layanan ini. Pilih layanan lain.',
                    errorKeyboard
                );
                return;
            }

            const finalPrice = parseInt(service.price) + this.config.MARKUP_PROFIT;

            if (finalPrice > oldPrice) {
                this.pendingOrders.delete(processingKey);
                const priceChangeKeyboard = {
                    inline_keyboard: [
                        [{ text: `✅ Lanjut Bayar Rp ${finalPrice.toLocaleString('id-ID')}`, 
                          callback_data: `buy_confirm_${serviceId}_${country}_${finalPrice}_${serviceName.replace(/\s/g, '_')}` }],
                        [{ text: '🔙 Batal', callback_data: `country_${country}_page_0` }]
                    ]
                };
                
                await editPhotoCaption(
                    this.bot,
                    chatId,
                    messageId,
                    this.botLogo,
                    `⚠️ *HARGA BERUBAH!*\n\n` +
                    `📧 Layanan: ${serviceName}\n` +
                    `💰 Harga Lama: Rp ${oldPrice.toLocaleString('id-ID')}\n` +
                    `💰 Harga Baru: Rp ${finalPrice.toLocaleString('id-ID')}\n` +
                    `📈 Naik: Rp ${(finalPrice - oldPrice).toLocaleString('id-ID')}\n\n` +
                    `Harga dari provider naik. Lanjutkan?`,
                    priceChangeKeyboard
                );
                return;
            }

            const user = await this.getUser(userId);
            if (!user || user.saldo < finalPrice) {
                this.pendingOrders.delete(processingKey);
                const currentSaldo = user ? user.saldo : 0;
                const keyboard = {
                    inline_keyboard: [[{ text: '💳 Top Up Saldo', callback_data: 'topup' }]]
                };
                await editPhotoCaption(
                    this.bot,
                    chatId,
                    messageId,
                    this.botLogo,
                    `❌ *Saldo Tidak Cukup*\n\n` +
                    `Saldo Anda: Rp ${currentSaldo.toLocaleString('id-ID')}\n` +
                    `Dibutuhkan: Rp ${finalPrice.toLocaleString('id-ID')}\n` +
                    `Kurang: Rp ${(finalPrice - currentSaldo).toLocaleString('id-ID')}`,
                    keyboard
                );
                return;
            }

            await editPhotoCaption(
                this.bot,
                chatId,
                messageId,
                this.botLogo,
                '⏳ Sedang memproses pembelian...\n\nHarap tunggu, jangan tekan apapun.',
                { inline_keyboard: [] }
            );

            const orderResponse = await this.apiRequest('order', {
                service: serviceId,
                operator: 'any'
            });

            if (!orderResponse || !orderResponse.status) {
                this.pendingOrders.delete(processingKey);
                
                const errorInfo = this.getOrderErrorMessage(orderResponse);
                
                const errorKeyboard = {
                    inline_keyboard: [
                        [{ text: '🔙 Kembali', callback_data: `country_${country}_page_0` }],
                        [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                    ]
                };

                let errorText = `❌ *Order ERROR*\n💳 Saldo Tidak Dikurangi\n\n`;
                
                if (errorInfo.type === "restock") {
                    errorText += `📦 *Status:* Sedang Restock\n\n`;
                } else if (errorInfo.type === "provider_balance") {
                    errorText += `💰 *Status:* Saldo Provider Habis\n\n`;
                } else if (errorInfo.type === "service_down") {
                    errorText += `🔧 *Status:* Layanan Maintenance\n\n`;
                } else if (errorInfo.type === "no_numbers") {
                    errorText += `📱 *Status:* Nomor Habis\n\n`;
                } else {
                    errorText += `⚠️ *Status:* Error Provider\n\n`;
                }
                
                errorText += `🔄 *Respon Original:*\n${errorInfo.message}\n\n`;
                errorText += `💡 *Solusi:*\n${errorInfo.solution}`;

                await editPhotoCaption(
                    this.bot,
                    chatId,
                    messageId,
                    this.botLogo,
                    errorText,
                    errorKeyboard
                );
                return;
            }

            const { id: orderId, number } = orderResponse.data;

            const users = await this.db.loadUsers();
            const userIndex = users.findIndex(u => u.id === userId.toString());
            
            if (userIndex === -1) {
                await this.apiRequest('set_status', { id: orderId, status: '2' });
                this.pendingOrders.delete(processingKey);
                await editPhotoCaption(
                    this.bot,
                    chatId,
                    messageId,
                    this.botLogo,
                    `❌ User tidak ditemukan saat potong saldo.`,
                    { inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'back_main' }]] }
                );
                return;
            }

            if (users[userIndex].saldo < finalPrice) {
                await this.apiRequest('set_status', { id: orderId, status: '2' });
                this.pendingOrders.delete(processingKey);
                await editPhotoCaption(
                    this.bot,
                    chatId,
                    messageId,
                    this.botLogo,
                    `❌ Saldo tidak mencukupi saat pembelian.`,
                    { inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'back_main' }]] }
                );
                return;
            }

            users[userIndex].saldo -= finalPrice;
            users[userIndex].date = this.getIndonesianTimestamp();
            await this.db.saveUsers(users);

            const currentOrders = await this.db.loadOrders();
            currentOrders[userId] = {
                orderId,
                number,
                price: finalPrice,
                country,
                serviceId,
                serviceName,
                timestamp: Date.now(),
                chatId,
                messageId,
                status: 'active',
                userName: await this.getUserName(userId)
            };
            await this.db.saveOrders(currentOrders);

            setTimeout(async () => {
                await this.apiRequest('set_status', { id: orderId, status: '1' });
            }, 3000);

            this.pendingOrders.delete(processingKey);

            const countryFlag = this.getCountryFlag(country);
            const orderText = `📱 *Order Berhasil!*\n\n` +
                `📱 Nomor: +${number}\n` +
                `📧 Layanan: ${serviceName}\n` +
                `${countryFlag} Negara: ${country}\n` +
                `💰 Harga: Rp ${finalPrice.toLocaleString('id-ID')}\n` +
                `🆔 ID: ${orderId}\n\n` +
                `📂 *Langkah Selanjutnya:*\n` +
                `• Gunakan nomor untuk registrasi\n` +
                `• Minta kode OTP\n` +
                `• SMS akan dikirim otomatis\n` +
                `• Jika 5 menit tidak ada SMS = refund otomatis\n\n` +
                `⏰ Menunggu SMS masuk...\n\n` +
                `💡 *Button cancel akan muncul dalam 5 menit*`;

            await editPhotoCaption(
                this.bot,
                chatId,
                messageId,
                this.botLogo,
                orderText,
                { inline_keyboard: [] }
            );

            this.startSMSMonitoring(userId, orderId);

            setTimeout(async () => {
                try {
                    const currentOrders = await this.db.loadOrders();
                    if (currentOrders[userId] && currentOrders[userId].status === 'active') {
                        const keyboard = {
                            inline_keyboard: [[{ text: '❌ Batalkan Order', callback_data: `cancel_${orderId}` }]]
                        };

                        const updatedText = `📱 *Order Berhasil!*\n\n` +
                            `📱 Nomor: +${number}\n` +
                            `📧 Layanan: ${serviceName}\n` +
                            `${countryFlag} Negara: ${country}\n` +
                            `💰 Harga: Rp ${finalPrice.toLocaleString('id-ID')}\n` +
                            `🆔 ID: ${orderId}\n\n` +
                            `📂 *Langkah Selanjutnya:*\n` +
                            `• Gunakan nomor untuk registrasi\n` +
                            `• Minta kode OTP\n` +
                            `• SMS akan dikirim otomatis\n` +
                            `• Auto refund jika tidak ada SMS dalam 3 menit lagi\n\n` +
                            `⏰ Menunggu SMS masuk...\n` +
                            `✅ Button cancel sudah tersedia`;

                        await editPhotoCaption(
                            this.bot,
                            chatId,
                            messageId,
                            this.botLogo,
                            updatedText,
                            keyboard
                        );
                    }
                } catch (error) {
                    console.log('Error showing cancel button:', error.message);
                }
            }, 300000);

        } catch (error) {
            this.pendingOrders.delete(processingKey);
            console.error('Purchase error:', error);
            
            const errorKeyboard = {
                inline_keyboard: [
                    [{ text: '🔙 Kembali', callback_data: `country_${country}_page_0` }],
                    [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                ]
            };

            await editPhotoCaption(
                this.bot,
                chatId,
                messageId,
                this.botLogo,
                '❌ *Terjadi Kesalahan Sistem*\n\n💳 Saldo Tidak Dikurangi\n\nSilakan coba lagi atau hubungi admin.',
                errorKeyboard
            );
        }
    }

    async startSMSMonitoring(userId, orderId) {
        let attempt = 0;
        const maxAttempts = this.config.MAX_CHECK_ATTEMPTS;

        if (this.activeMonitors.has(userId)) {
            clearInterval(this.activeMonitors.get(userId));
        }

        const monitor = setInterval(async () => {
            attempt++;

            try {
                const orders = await this.db.loadOrders();
                if (!orders[userId] || orders[userId].orderId !== orderId || orders[userId].status !== 'active') {
                    clearInterval(monitor);
                    this.activeMonitors.delete(userId);
                    return;
                }

                const orderData = orders[userId];
                const statusResponse = await this.apiRequest('status', { id: orderId });

                if (statusResponse?.status && statusResponse.data?.status === 'Success' && statusResponse.data?.sms) {
                    const smsCode = statusResponse.data.sms;

                    const currentOrders = await this.db.loadOrders();
                    if (currentOrders[userId] && currentOrders[userId].status === 'active') {
                        currentOrders[userId].status = 'completed';
                        await this.db.saveOrders(currentOrders);
                        
                        await this.apiRequest('set_status', { id: orderId, status: '4' });

                        await this.addToHistory(userId, currentOrders[userId], smsCode);

                        delete currentOrders[userId];
                        await this.db.saveOrders(currentOrders);

                        clearInterval(monitor);
                        this.activeMonitors.delete(userId);

                        const keyboard = {
                            inline_keyboard: [[{ text: '📱 Beli Lagi', callback_data: 'buy_start' }]]
                        };

                        const timeInfo = this.getIndonesianTime();
                        const countryFlag = this.getCountryFlag(orderData.country);

                        const successText = `📨 *SMS Berhasil Diterima!*\n\n` +
                            `🔑 Kode OTP: *${smsCode}*\n` +
                            `📱 Nomor: +${orderData.number}\n` +
                            `📧 Layanan: ${orderData.serviceName}\n` +
                            `${countryFlag} Negara: ${orderData.country}\n` +
                            `📅 Tanggal: ${timeInfo.date}\n` +
                            `🕐 Jam: ${timeInfo.time}\n\n` +
                            `✅ Transaksi selesai!\n` +
                            `📜 Order disimpan di riwayat.`;

                        await editPhotoCaption(
                            this.bot,
                            orderData.chatId,
                            orderData.messageId,
                            this.botLogo,
                            successText,
                            keyboard
                        );

                        await this.sendTestimoniToChannel(orderData, smsCode);
                    }
                    return;
                }

                if (attempt >= maxAttempts) {
                    clearInterval(monitor);
                    this.activeMonitors.delete(userId);
                    await this.autoRefund(userId, orderId);
                }

            } catch (error) {
                console.error('SMS Monitor error:', error);
            }
        }, 15000);

        this.activeMonitors.set(userId, monitor);
    }

    async autoRefund(userId, orderId) {
        const refundKey = `refund_${userId}_${orderId}`;
        
        if (this.refundLocks.has(refundKey)) {
            console.log(`Refund already processed for ${userId}-${orderId}`);
            return;
        }
        
        this.refundLocks.add(refundKey);
        
        try {
            if (this.activeMonitors.has(userId)) {
                clearInterval(this.activeMonitors.get(userId));
                this.activeMonitors.delete(userId);
            }

            await this.apiRequest('set_status', { id: orderId, status: '2' });

            const orders = await this.db.loadOrders();
            if (orders[userId] && orders[userId].orderId === orderId) {
                const orderData = orders[userId];

                const refundResult = await this.updateUserSaldo(userId, orderData.price, 'add');
                
                if (refundResult.success) {
                    delete orders[userId];
                    await this.db.saveOrders(orders);

                    const keyboard = {
                        inline_keyboard: [[{ text: '📱 Coba Lagi', callback_data: 'buy_start' }]]
                    };

                    const refundText = `⏰ *Timeout - SMS Tidak Masuk*\n\n` +
                        `💰 Saldo Rp ${orderData.price.toLocaleString('id-ID')} telah dikembalikan\n` +
                        `💳 Saldo total: Rp ${refundResult.newSaldo.toLocaleString('id-ID')}\n` +
                        `🆔 Order ID: ${orderId}\n\n` +
                        `Silakan coba layanan lain atau coba lagi nanti.`;

                    await editPhotoCaption(
                        this.bot,
                        orderData.chatId,
                        orderData.messageId,
                        this.botLogo,
                        refundText,
                        keyboard
                    );
                }
            }
        } catch (error) {
            console.error('Auto refund error:', error);
        } finally {
            setTimeout(() => {
                this.refundLocks.delete(refundKey);
            }, 5000);
        }
    }

    async handleDeposit(msg, match) {
        const chatId = msg.chat.id;
        const userId = msg.from.id;
        const nominalAsli = parseInt(match[1]);

        if (!nominalAsli || nominalAsli < 1000) {
            return this.bot.sendMessage(chatId, "❌ Minimal deposit Rp 1,000\nContoh: `/deposit 5000`", {
                parse_mode: 'Markdown'
            });
        }

        const activeDeposit = this.autoPending.find(trx => 
            trx.id === chatId && !trx.done && !trx.cancelled
        );

        if (activeDeposit) {
            const elapsedTime = Date.now() - activeDeposit.startTime;
            const elapsedMinutes = Math.floor(elapsedTime / 60000);
            const elapsedSeconds = Math.floor((elapsedTime % 60000) / 1000);
            
            const timeText = elapsedMinutes > 0 
                ? `${elapsedMinutes} menit ${elapsedSeconds} detik`
                : `${elapsedSeconds} detik`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: "❌ Cancel Deposit Aktif", callback_data: `cancel_deposit_${activeDeposit.trx_id}` }]
                ]
            };

            return this.bot.sendMessage(chatId, 
                `⚠️ *DEPOSIT MASIH AKTIF*\n\n` +
                `🆔 ID: \`${activeDeposit.trx_id}\`\n` +
                `💰 Nominal: Rp ${activeDeposit.get_balance.toLocaleString('id-ID')}\n` +
                `⏰ Dibuat: ${timeText} yang lalu\n\n` +
                `❌ Anda harus **cancel** terlebih dahulu sebelum membuat deposit baru.\n\n` +
                `💡 Klik tombol di bawah untuk cancel:`,
                { 
                    parse_mode: 'Markdown',
                    reply_markup: keyboard
                }
            );
        }

        try {
            const reff_id = `reff-${chatId}-${Date.now()}`;

            const res = await this.ciaaTopUpRequest('/h2h/deposit/create', {
                nominal: nominalAsli.toString(),
                metode: 'QRISFAST'
            });

            if (!res || !res.success || !res.data || !res.data.qr_string) {
                return this.bot.sendMessage(chatId, "❌ Gagal membuat deposit.\n\n🔍 Respon: " + JSON.stringify(res));
            }

            const data = res.data;
            
            const qrBuffer = await QRCode.toBuffer(data.qr_string);

            const fee = data.fee || 0;
            const getBalance = data.get_balance || nominalAsli;
            const totalPay = parseInt(data.nominal) || nominalAsli;

            const teks = `\`\`\`💳 PEMBAYARAN VIA QRIS\n` +
                `🆔 *ID Transaksi:* \`${data.id}\`\n` +
                `💰 Nominal: Rp ${nominalAsli.toLocaleString("id-ID")}\n` +
                `🧾 Biaya Admin: Rp ${fee.toLocaleString("id-ID")}\n` +
                `💸 Total Bayar: Rp ${totalPay.toLocaleString("id-ID")}\n` +
                `💵 Saldo Diterima: Rp ${getBalance.toLocaleString("id-ID")}\n` +
                `📅 Expired: ${data.expired_at}\n\n` +
                `📲 Scan QR di bawah pakai:\n` +
                `DANA / OVO / ShopeePay / GoPay/DLL\n\n` +
                `Saldo akan otomatis masuk setelah pembayaran berhasil.\n\n` +
                `⏰ PENTING: Deposit ini akan auto-cancel dalam 10 menit jika tidak dibayar.\n` +
                `⚠️ Segera bayar agar tidak di-cancel otomatis!\n\n` +
                `💬 Jika sudah transfer dan saldo tidak masuk dalam 5 menit, segera hubungi owner @Jeeyhosting\`\`\``;

            const inlineKeyboard = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "❌ BATAL", callback_data: `cancel_deposit_${data.id}` }]
                    ]
                }
            };

            const sent = await this.bot.sendPhoto(chatId, qrBuffer, {
                caption: teks,
                parse_mode: "Markdown",
                ...inlineKeyboard
            });

            this.autoPending.push({
                id: chatId,
                trx_id: data.id,
                get_balance: getBalance,
                user_name: msg.from.first_name + (msg.from.last_name ? " " + msg.from.last_name : ""),
                done: false,
                msgId: sent.message_id,
                startTime: Date.now()
            });

        } catch (err) {
            console.log("❌ ERROR DEPOSIT:", err.message);
            this.bot.sendMessage(chatId, "❌ Terjadi kesalahan saat membuat deposit.");
        }
    }

    async cancelDeposit(query) {
        const msg = query.message;
        const data = query.data;
        const chatId = msg.chat.id;
        const trxId = data.replace('cancel_deposit_', '');

        console.log(`Cancel deposit request for transaction: ${trxId}`);

        try {
            const pendingIndex = this.autoPending.findIndex(trx => trx.trx_id === trxId && !trx.done);
            
            if (pendingIndex === -1) {
                await this.bot.answerCallbackQuery(query.id, {
                    text: "❌ Transaksi tidak ditemukan atau sudah selesai",
                    show_alert: true
                });
                return;
            }

            this.autoPending[pendingIndex].done = true;
            this.autoPending[pendingIndex].cancelled = true;

            try {
                await this.bot.deleteMessage(chatId, msg.message_id);
                console.log(`✅ QRIS message deleted for ${trxId}`);
            } catch (deleteError) {
                console.log(`⚠️ Cannot delete QRIS message: ${deleteError.message}`);
            }

            let ciaaStatus = 'local_cancelled';
            
            try {
                const cancelRes = await this.ciaaTopUpRequest('/h2h/deposit/cancel', {
                    id: trxId
                });

                if (cancelRes && cancelRes.success === true) {
                    ciaaStatus = 'ciaa_cancelled';
                }
            } catch (ciaaError) {
                console.log(`CiaaTopUp cancel timeout/error: ${ciaaError.message}`);
            }

            const timeInfo = this.getIndonesianTime();
            const nominal = this.autoPending[pendingIndex].get_balance;
            
            const successText = `\`\`\`✅ DEPOSIT DIBATALKAN\n\n` +
                `🆔 ID: \`${trxId}\`\n` +
                `💰 Nominal: Rp ${nominal.toLocaleString('id-ID')}\n` +
                `📊 Status: Berhasil dibatalkan\n` +
                `📅 Tanggal: ${timeInfo.date}\n` +
                `🕐 Jam: ${timeInfo.time}\n\n` +
                `💡 Silakan buat deposit baru jika diperlukan.\n` +
                `Ketik /start Untuk Ke Menu Utama\`\`\``;

            const keyboard = {
                inline_keyboard: []
            };

            await this.bot.sendMessage(chatId, successText, {
                parse_mode: "Markdown",
                reply_markup: keyboard
            });

            await this.bot.answerCallbackQuery(query.id, {
                text: "✅ Transaksi berhasil dibatalkan"
            });

            console.log(`✅ Cancel deposit completed for ${trxId}`);

        } catch (err) {
            console.error(`❌ CRITICAL ERROR cancelDeposit ${trxId}:`, err.message);
            
            try {
                const emergencyIndex = this.autoPending.findIndex(trx => trx.trx_id === trxId);
                if (emergencyIndex !== -1) {
                    this.autoPending[emergencyIndex].done = true;
                    this.autoPending[emergencyIndex].cancelled = true;
                }

                await this.bot.sendMessage(chatId, 
                    `❌ DEPOSIT DIBATALKAN (ERROR SISTEM)\n\n` +
                    `ID: ${trxId}\n` +
                    `Status: Dibatalkan meskipun ada error\n` +
                    `Waktu: ${new Date().toLocaleString('id-ID')}\n\n` +
                    `Hubungi admin jika ada masalah: @Jeeyhosting`
                );

                await this.bot.answerCallbackQuery(query.id, {
                    text: "⚠️ Dibatalkan tapi ada error sistem"
                });

            } catch (emergencyError) {
                console.error(`❌ EMERGENCY FALLBACK FAILED:`, emergencyError.message);
                
                try {
                    await this.bot.answerCallbackQuery(query.id, {
                        text: "❌ Error sistem, hubungi admin"
                    });
                } catch (finalError) {
                    console.error(`❌ FINAL FALLBACK FAILED:`, finalError.message);
                }
            }
        }
    }

    startDepositMonitoring() {
        setInterval(async () => {
            for (let i = 0; i < this.autoPending.length; i++) {
                const trx = this.autoPending[i];
                if (trx.done || trx.cancelled) continue;

                if (!trx.startTime) {
                    trx.startTime = Date.now();
                }

                const elapsedTime = Date.now() - trx.startTime;
                const maxMonitoringTime = 10 * 60 * 1000;

                if (elapsedTime > maxMonitoringTime && !trx.done) {
                    console.log(`⏰ Auto-cancelling deposit ${trx.trx_id} after 10 minutes`);
                    trx.done = true;
                    
                    try {
                        await this.ciaaTopUpRequest('/h2h/deposit/cancel', {
                            id: trx.trx_id
                        });
                    } catch (cancelErr) {
                        console.log(`⚠️ Failed to cancel at CiaaTopUp: ${cancelErr.message}`);
                    }
                    
                    await this.cleanupDeposit(trx.id, trx.msgId, trx.trx_id, trx.get_balance, 'expired');
                    continue;
                }

                try {
                    const res = await this.ciaaTopUpRequest('/h2h/deposit/status', {
                        id: trx.trx_id
                    });
                    
                    const status = res?.data?.status;

                    if (status === "success") {
                        const users = await this.db.loadUsers();
                        const userIndex = users.findIndex(user => user.id === trx.id.toString());

                        if (userIndex !== -1) {
                            users[userIndex].saldo += trx.get_balance;
                            users[userIndex].date = this.getIndonesianTimestamp();
                        } else {
                            users.push({
                                id: trx.id.toString(),
                                saldo: trx.get_balance,
                                date: this.getIndonesianTimestamp()
                            });
                        }

                        await this.db.saveUsers(users);
                        trx.done = true;
                        trx.completedAt = Date.now();
                        await this.cleanupDeposit(trx.id, trx.msgId, trx.trx_id, trx.get_balance, 'success');

                    } else if (["expired", "failed", "cancel"].includes(status)) {
                        trx.done = true;
                        trx.completedAt = Date.now();
                        await this.cleanupDeposit(trx.id, trx.msgId, trx.trx_id, trx.get_balance, 'expired');
                    }

                } catch (err) {
                    console.log(`[AUTO-CEK] Gagal cek ${trx.trx_id}:`, err.message);
                }
            }
        }, 10 * 1000);
    }

    async cleanupDeposit(chatId, msgId, trxId, nominal, status) {
        try { await this.bot.deleteMessage(chatId, msgId); } catch {}
        const time = this.getIndonesianTime();
        const text = status === 'success'
            ? `✅ Deposit sukses Rp ${nominal.toLocaleString('id-ID')}`
            : `⏰ Deposit expired Rp ${nominal.toLocaleString('id-ID')}`;
        await this.bot.sendMessage(chatId, `${text}\n🆔 ${trxId} | 🕐 ${time.full}`, { parse_mode: 'Markdown' });
    }

    startCleanupWorker() {
        setInterval(() => {
            const now = Date.now();
            
            for (const [lockId, timestamp] of this.userLocks.entries()) {
                if (now - timestamp > 30000) {
                    console.log(`Clearing stuck lock: ${lockId}`);
                    this.userLocks.delete(lockId);
                }
            }
            
            this.pendingOrders.clear();
            
            const oldRefundLocks = [];
            for (const refundKey of this.refundLocks) {
                oldRefundLocks.push(refundKey);
            }
            
            if (oldRefundLocks.length > 100) {
                oldRefundLocks.slice(0, 50).forEach(key => this.refundLocks.delete(key));
            }
            
            this.autoPending = this.autoPending.filter(trx => {
                if (trx.done || trx.cancelled) {
                    const timeSinceDone = now - (trx.completedAt || trx.startTime || 0);
                    if (timeSinceDone > 5 * 60 * 1000) {
                        console.log(`🗑️ Removing completed transaction ${trx.trx_id} from memory`);
                        return false;
                    }
                }
                return true;
            });
            
        }, 60000);
    }

    async cancelOrder(chatId, messageId, data, userId) {
        const orderId = data.replace('cancel_', '');
        const refundKey = `refund_${userId}_${orderId}`;
        
        if (this.refundLocks.has(refundKey)) {
            await this.bot.editMessageText('❌ *Sedang Memproses Pembatalan*\n\nHarap tunggu, sistem sedang membatalkan order Anda...', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            });
            return;
        }

        const orders = await this.db.loadOrders();
        if (!orders[userId] || orders[userId].orderId !== orderId) {
            const keyboard = {
                inline_keyboard: [[{ text: '🏠 Menu Utama', callback_data: 'back_main' }]]
            };

            await this.bot.editMessageText('❌ *Order Tidak Ditemukan*\n\nOrder mungkin sudah selesai atau dibatalkan.', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard,
                parse_mode: 'Markdown'
            });
            return;
        }

        const orderData = orders[userId];
        const orderTime = orderData.timestamp;
        const elapsed = Date.now() - orderTime;
        const elapsedMinutes = Math.floor(elapsed / 60000);
        
        if (elapsedMinutes < 5) {
            const remainingTime = 5 - elapsedMinutes;
            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔄 Refresh', callback_data: 'active_orders' }],
                    [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                ]
            };

            await this.bot.editMessageText(
                `⏰ *Belum Bisa Dibatalkan*\n\n` +
                `Provider membutuhkan minimal 5 menit untuk memproses cancel.\n\n` +
                `⏳ Sisa waktu: ${remainingTime} menit\n` +
                `📱 Nomor: +${orderData.number}\n` +
                `💰 Harga: Rp ${orderData.price.toLocaleString('id-ID')}\n\n` +
                `🤖 *Auto cancel akan berjalan jika SMS tidak masuk dalam 3 menit lagi.*`,
                {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: keyboard,
                    parse_mode: 'Markdown'
                }
            );
            return;
        }
        
        this.refundLocks.add(refundKey);
        
        try {
            await this.bot.editMessageText('⏳ *Membatalkan Order...*\n\nSedang memproses pembatalan, harap tunggu...', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown'
            });

            if (this.activeMonitors.has(userId)) {
                clearInterval(this.activeMonitors.get(userId));
                this.activeMonitors.delete(userId);
            }

            orderData.status = 'cancelling';
            orders[userId] = orderData;
            await this.db.saveOrders(orders);

            let cancelSuccess = false;
            let attempts = 0;
            const maxRetries = 3;

            while (!cancelSuccess && attempts < maxRetries) {
                attempts++;
                console.log(`Cancel attempt ${attempts} for order ${orderId}`);
                
                try {
                    const cancelResponse = await this.apiRequest('set_status', { id: orderId, status: '2' });
                    
                    if (cancelResponse && cancelResponse.status) {
                        cancelSuccess = true;
                        console.log(`✅ Cancel berhasil untuk order ${orderId}`);
                    } else {
                        console.log(`❌ Cancel attempt ${attempts} gagal:`, cancelResponse?.data?.msg || 'No response');
                        if (attempts < maxRetries) {
                            await new Promise(resolve => setTimeout(resolve, 2000));
                        }
                    }
                } catch (error) {
                    console.log(`❌ Cancel attempt ${attempts} error:`, error.message);
                    if (attempts < maxRetries) {
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    }
                }
            }

            const refundResult = await this.updateUserSaldo(userId, orderData.price, 'add');
            
            if (refundResult.success) {
                const currentOrders = await this.db.loadOrders();
                if (currentOrders[userId]) {
                    delete currentOrders[userId];
                    await this.db.saveOrders(currentOrders);
                }

                const keyboard = {
                    inline_keyboard: [[{ text: '📱 Beli Lagi', callback_data: 'buy_start' }]]
                };

                const successMsg = cancelSuccess ? 
                    '✅ Berhasil dibatalkan di provider' : 
                    '⚠️ Cancel API timeout, tapi saldo tetap dikembalikan';

                const cancelText = `❌ *Order Dibatalkan*\n\n` +
                    `💰 Saldo Rp ${orderData.price.toLocaleString('id-ID')} telah dikembalikan\n` +
                    `💳 Saldo total: Rp ${refundResult.newSaldo.toLocaleString('id-ID')}\n\n` +
                    `🔍 Status: ${successMsg}\n\n` +
                    `Terima kasih!`;

                await this.bot.editMessageText(cancelText, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: keyboard,
                    parse_mode: 'Markdown'
                });
            } else {
                orderData.status = 'active';
                orders[userId] = orderData;
                await this.db.saveOrders(orders);

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '🔄 Coba Lagi', callback_data: `cancel_${orderId}` }],
                        [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                    ]
                };

                await this.bot.editMessageText(`❌ *Gagal Refund Saldo*\n\n${refundResult.message}\n\nSilakan coba lagi.`, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: keyboard,
                    parse_mode: 'Markdown'
                });
            }

        } catch (error) {
            console.error('Cancel order error:', error);
            
            const currentOrders = await this.db.loadOrders();
            if (currentOrders[userId]) {
                currentOrders[userId].status = 'active';
                await this.db.saveOrders(currentOrders);
            }

            const keyboard = {
                inline_keyboard: [
                    [{ text: '🔄 Coba Lagi', callback_data: `cancel_${orderId}` }],
                    [{ text: '🏠 Menu Utama', callback_data: 'back_main' }]
                ]
            };

            await this.bot.editMessageText('❌ *Error Sistem*\n\nTerjadi kesalahan saat membatalkan. Coba lagi.', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard,
                parse_mode: 'Markdown'
            });

        } finally {
            setTimeout(() => {
                this.refundLocks.delete(refundKey);
            }, 10000);
        }
    }

    async checkBalance(chatId, messageId, userId) {
        const user = await this.getUser(userId);
        const saldo = user ? user.saldo : 0;
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '💳 Top Up', callback_data: 'topup' }],
                [{ text: '🔙 Menu Utama', callback_data: 'back_main' }]
            ]
        };

        const text = saldo === 0 ? 
            '💰 Saldo Anda\n\nRp 0\n\nSilakan top up untuk mulai order.' :
            `💰 Saldo Anda\n\nRp ${saldo.toLocaleString('id-ID')}`;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, text, keyboard);
    }
    
    async showOrderHistory(chatId, messageId, userId) {
        const history = await this.db.loadHistory();
        const userHistory = history[userId] || [];
        
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔄 Refresh', callback_data: 'order_history' }],
                [{ text: '🔙 Menu Utama', callback_data: 'back_main' }]
            ]
        };

        if (userHistory.length === 0) {
            const emptyText = '📜 RIWAYAT ORDER\n\n🔍 Belum ada riwayat order.\nRiwayat akan muncul setelah Anda berhasil mendapatkan SMS.';
            
            try {
                await this.bot.editMessageCaption(emptyText, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: keyboard,
                    parse_mode: 'Markdown'
                });
            } catch (e) {
                if (e.response?.body?.description?.includes("message is not modified")) {
                    return;
                }
                await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, emptyText, keyboard);
            }
            return;
        }

        let historyText = '📜 RIWAYAT ORDER\n\n';
        historyText += '📊 Total: ' + userHistory.length + ' order berhasil\n\n';

        const displayHistory = userHistory.slice(0, 5);
        
        displayHistory.forEach((order, index) => {
            const hiddenNumber = order.number ? 
                order.number.substring(0, 4) + 'xxx' + order.number.substring(order.number.length - 3) :
                'N/A';
            
            const fullOTP = order.smsCode || 'N/A';
            const countryFlag = this.getCountryFlag(order.country || '');
            
            historyText += (index + 1) + '. 📱 ' + (order.serviceName || 'Unknown Service') + '\n';
            historyText += '   ' + countryFlag + ' ' + (order.country || 'Unknown') + '\n';
            historyText += '   📞 +' + hiddenNumber + '\n';
            historyText += '   🔑 OTP: ' + fullOTP + '\n';
            historyText += '   💰 Rp ' + (order.price ? order.price.toLocaleString('id-ID') : '0') + '\n';
            historyText += '   📅 ' + (order.completedAt || 'Unknown time') + '\n\n';
        });

        if (userHistory.length > 5) {
            historyText += '... dan ' + (userHistory.length - 5) + ' order lainnya\n\n';
        }

        historyText += '💡 Info: Hanya 5 order terakhir yang ditampilkan.\n';
        historyText += 'Order yang berhasil mendapat SMS tersimpan di riwayat.';

        if (historyText.length > 1000) {
            historyText = historyText.substring(0, 950) + '\n\n... (terpotong)';
        }

        try {
            await this.bot.editMessageCaption(historyText, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: keyboard,
                parse_mode: 'Markdown'
            });
        } catch (e) {
            if (e.response?.body?.description?.includes("message is not modified")) {
                return;
            }
            await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, historyText, keyboard);
        }
    }

    async showActiveOrders(chatId, messageId, userId) {
        const orders = await this.db.loadOrders();
        
        if (!orders[userId]) {
            const keyboard = {
                inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'back_main' }]]
            };

            await editPhotoCaption(
                this.bot,
                chatId,
                messageId,
                this.botLogo,
                '📋 *Tidak ada pesanan aktif*',
                keyboard
            );
            return;
        }

        const order = orders[userId];
        const elapsedTime = Date.now() - order.timestamp;
        const elapsedMinutes = Math.floor(elapsedTime / 60000);
        const elapsedSeconds = Math.floor((elapsedTime % 60000) / 1000);

        let statusText = '';
        let buttonText = '';
        let callbackData = '';
        
        if (order.status === 'cancelling') {
            statusText = '🔄 Sedang dibatalkan...';
            buttonText = '⏳ Memproses...';
            callbackData = 'cancel_processing';
        } else if (elapsedMinutes < 5) {
            const remainingMinutes = 5 - elapsedMinutes;
            const remainingSeconds = 60 - elapsedSeconds;
            if (remainingMinutes > 0) {
                statusText = `⏳ Button cancel muncul dalam ${remainingMinutes} menit`;
            } else {
                statusText = `⏳ Button cancel muncul dalam ${remainingSeconds} detik`;
            }
            buttonText = '⏰ Tunggu 5 Menit';
            callbackData = 'cancel_wait_5_minutes';
        } else if (elapsedMinutes >= 8) {
            statusText = '🔴 Auto refund akan dimulai';
            buttonText = '❌ Batalkan Sekarang';
            callbackData = `cancel_${order.orderId}`;
        } else {
            statusText = '✅ Bisa dibatalkan manual';
            buttonText = '❌ Batalkan Order';
            callbackData = `cancel_${order.orderId}`;
        }

        const keyboard = {
            inline_keyboard: [
                [{ text: buttonText, callback_data: callbackData }],
                [{ text: '🔄 Refresh', callback_data: 'active_orders' }],
                [{ text: '🔙 Menu Utama', callback_data: 'back_main' }]
            ]
        };

        let timeText = '';
        if (elapsedMinutes > 0) {
            timeText = `${elapsedMinutes} menit ${elapsedSeconds} detik yang lalu`;
        } else {
            timeText = `${elapsedSeconds} detik yang lalu`;
        }

        const countryFlag = this.getCountryFlag(order.country);
        const activeText = `\`\`\`📋 Pesanan Aktif\n\n` +
            `📱 Nomor: +${order.number}\n` +
            `📧 Layanan: ${order.serviceName}\n` +
            `${countryFlag} Negara: ${order.country}\n` +
            `💰 Harga: Rp ${order.price.toLocaleString('id-ID')}\n` +
            `🆔 ID: ${order.orderId}\n` +
            `⏰ Waktu: ${timeText}\n\n` +
            `📊 Status: ${statusText}\n\n` +
            `⏳ Menunggu SMS masuk...\n` +
            `🤖 Auto refund jika tidak ada SMS dalam 5 menit\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, activeText, keyboard);
    }

    async showTopup(chatId, messageId) {
        const keyboard = {
            inline_keyboard: [
                [{ text: '🔙 Menu Utama', callback_data: 'back_main' }]
            ]
        };

        const topupText = `\`\`\`💳 Top Up Saldo\n\n` +
            `🤖 Deposit Otomatis via QRIS:\n` +
            `Gunakan command: /deposit JUMLAH\n\n` +
            `🔍 *Contoh:*\n` +
            `• /deposit 10000 = Top up Rp 10,000\n` +
            `• /deposit 50000 = Top up Rp 50,000\n\n` +
            `💰 Minimum deposit: Rp 1,000\n` +
            `🏦 Biaya admin: Sesuai provider payment\n` +
            `⚡ Proses: Otomatis & Instan\n` +
            `💳 Metode: DANA, OVO, GoPay, ShopeePay\n\n` +
            `📞 Manual Transfer:*\n` +
            `Hubungi admin jika butuh bantuan:\n` +
            `📱 Telegram: @Jeeyhosting\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, topupText, keyboard);
    }

    async showRules(chatId, messageId) {
        const keyboard = {
            inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'back_main' }]]
        };

        const rulesText = `\`\`\`📜 SYARAT & KETENTUAN

⚠️ WAJIB DIBACA:

🔸 1 nomor = 1 SMS/OTP  
🔸 Saldo tidak bisa ditarik/refund manual  
🔸 Tidak ada refund jika salah pilih layanan  
🔸 Bot tidak bertanggung jawab jika OTP sudah masuk  

🔸 Kebijakan:
- Order = setuju semua aturan
- SMS tidak masuk 8 menit = auto refund
- Saldo hanya untuk beli nomor SMS
- Force majeur: gangguan provider, saldo tetap aman

🔸 Tanggung Jawab:
- Nomor sudah terdaftar bukan tanggung jawab bot
- Kesalahan input / aplikasi tidak kirim OTP = user risk
- Gangguan jaringan provider = tunggu restock otomatis

👨‍💻 Butuh bantuan / report bug? → @Jeeyhosting\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, rulesText, keyboard);
    }

    async showHelp(chatId, messageId) {
        const keyboard = {
            inline_keyboard: [[{ text: '🔙 Menu Utama', callback_data: 'back_main' }]]
        };

        const helpText = `\`\`\`ℹ️ Bantuan SMS Bot

🤖 Cara Kerja:
1. Pilih negara & layanan
2. Konfirmasi pembelian
3. Dapat nomor langsung
4. SMS masuk otomatis
5. Refund otomatis jika gagal

💡 Tips Penggunaan:
- Pastikan layanan sesuai kebutuhan
- Gunakan nomor segera setelah dapat
- Jangan refresh/close bot saat menunggu SMS
- 1 nomor hanya untuk 1 akun baru

⚡ Kelebihan Bot:
- Proses instan 24/7
- Auto refund jika gagal
- Harga terjangkau
- Support multi negara

❓ FAQ:
- Nomor sudah terdaftar? = Coba layanan lain
- SMS tidak masuk? = Auto refund dalam 5 menit
- Salah pilih layanan? = Tidak bisa refund
- Mau tarik saldo? = TIDAK BISA, saldo hanya untuk beli nomor

⚠️ PENTING:
- Saldo yang ada di bot TIDAK BISA di-refund/ditarik
- Bot tidak bertanggung jawab jika OTP sudah dikirim

👨‍💻 Bot Creator: @Jeeyhosting
💬 Butuh bantuan? Hubungi @Jeeyhosting\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, helpText, keyboard);
    }

    async showMainMenu(chatId, messageId, userId) {
        const user = await this.getUser(userId);
        const saldoDisplay = user ? user.saldo.toLocaleString('id-ID') : '0';
        
        const keyboard = {
            inline_keyboard: [
                [
                    { text: '📱 Beli Nomor SMS', callback_data: 'buy_start' },
                    { text: '💰 Cek Saldo', callback_data: 'check_balance' }
                ],
                [
                    { text: '📋 Pesanan Aktif', callback_data: 'active_orders' },
                    { text: '📜 Riwayat Order', callback_data: 'order_history' }
                ],
                [
                    { text: '💳 Top Up', callback_data: 'topup' },
                    { text: '🏆 Top Users', callback_data: 'top_users' }
                ],
                [
                    { text: '📜 Syarat & Ketentuan', callback_data: 'rules' },
                    { text: 'ℹ️ Bantuan', callback_data: 'help' }
                ]
            ]
        };

        if (userId === this.config.OWNER_ID) {
            keyboard.inline_keyboard.push([
                { text: '👑 Owner Kontrol', callback_data: 'owner_panel' }
            ]);
        }

        const uniqueUsers = await this.loadUniqueUsers();
        const usersWithBalance = await this.getUsersWithBalance();
        const timeInfo = this.getIndonesianTime();
        
        const sanitizeUsername = (username) => {
            if (!username || username === 'Tidak ada') return username;
            return username.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
        };

        const usernameDisplay = await this.getUsernameDisplay(userId);
        const safeUsername = sanitizeUsername(usernameDisplay);

        const mainText = `\`\`\`🌟 SMS Bot Dashboard

👤 Info Akun:
Username: ${usernameDisplay !== 'Tidak ada' ? '@' + safeUsername : 'Tidak ada'}
ID: \`${userId}\`
📅 Tanggal: ${timeInfo.date}
🕐 Jam: ${timeInfo.time}

💰 Saldo: Rp ${saldoDisplay}

📊 Statistik Bot:
👥 Total User: ${uniqueUsers.length}
💳 Total User Deposit: ${usersWithBalance.length}

🤖 Fitur Otomatis:
✅ Beli nomor instan
✅ Terima SMS otomatis
✅ Selesai otomatis
✅ Refund otomatis jika gagal

⚠️ DISCLAIMER:
- Bot tidak bertanggung jawab jika OTP sudah dikirim ke chat ini
- Saldo yang ada di bot TIDAK BISA di-refund

👨‍💻 Bot Developer: @Jeeyhosting

Pilih menu di bawah:\`\`\``;

        await editPhotoCaption(this.bot, chatId, messageId, this.botLogo, mainText, keyboard);
    }

    async addUserToBroadcastList(userId) {
        try {
            const users = await this.db.loadBroadcastUsers();
            const userIdNum = parseInt(userId);
            
            const existingIndex = users.indexOf(userIdNum);
            if (existingIndex === -1) {
                users.push(userIdNum);
                await this.db.saveBroadcastUsers(users);
                console.log(`✅ Added user ${userIdNum} to broadcast list. Total users: ${users.length}`);
            }
        } catch (error) {
            console.error('Error adding user to broadcast list:', error);
        }
    }

    async loadUniqueUsers() {
        try {
            const users = await this.db.loadBroadcastUsers();
            return [...new Set(users)];
        } catch (error) {
            return [];
        }
    }

    async getUsersWithBalance() {
        try {
            const users = await this.db.loadUsers();
            const usersWithBalance = users.filter(user => user.saldo >= 100);
            return usersWithBalance;
        } catch (error) {
            return [];
        }
    }

    async getUser(userId) {
        const users = await this.db.loadUsers();
        return users.find(user => user.id === userId.toString());
    }

    async updateUserSaldo(userId, amount, operation = 'add') {
        try {
            const users = await this.db.loadUsers();
            const userIndex = users.findIndex(u => u.id === userId.toString());
            
            if (userIndex === -1) {
                return { success: false, message: 'User not found' };
            }
            
            const oldSaldo = users[userIndex].saldo;
            
            if (operation === 'add') {
                users[userIndex].saldo += amount;
            } else if (operation === 'subtract') {
                if (users[userIndex].saldo < amount) {
                    return { success: false, message: 'Insufficient balance' };
                }
                users[userIndex].saldo -= amount;
            }
            
            users[userIndex].date = this.getIndonesianTimestamp();
            await this.db.saveUsers(users);
            
            return { 
                success: true, 
                newSaldo: users[userIndex].saldo,
                oldSaldo: oldSaldo
            };
        } catch (error) {
            console.error('Update user saldo error:', error);
            return { success: false, message: 'System error' };
        }
    }

    async addToHistory(userId, orderData, smsCode) {
        try {
            const history = await this.db.loadHistory();
            
            if (!history[userId]) {
                history[userId] = [];
            }
            
            const timeInfo = this.getIndonesianTime();
            
            const historyEntry = {
                orderId: orderData.orderId,
                number: orderData.number,
                serviceName: orderData.serviceName,
                country: orderData.country,
                price: orderData.price,
                smsCode: smsCode,
                timestamp: Date.now(),
                completedAt: `${timeInfo.date} ${timeInfo.time}`
            };
            
            history[userId].unshift(historyEntry);
            
            if (history[userId].length > 20) {
                history[userId] = history[userId].slice(0, 20);
            }
            
            await this.db.saveHistory(history);
            
            await this.updateTopOrders(userId);
            
            console.log(`✅ Added order ${orderData.orderId} to history for user ${userId}`);
        } catch (error) {
            console.error('Error adding to history:', error);
        }
    }

    async updateTopOrders(userId) {
        try {
            const top = await this.db.loadTop();
            const userIndex = top.findIndex(user => user.id === userId);
            
            if (userIndex !== -1) {
                top[userIndex].count += 1;
            } else {
                top.push({
                    id: userId,
                    count: 1,
                    username: await this.getUsernameDisplay(userId)
                });
            }
            
            await this.db.saveTop(top);
        } catch (error) {
            console.error('Error updating top orders:', error);
        }
    }

    async getUserName(userId) {
        try {
            const chatInfo = await this.bot.getChat(userId);
            return chatInfo.first_name + (chatInfo.last_name ? " " + chatInfo.last_name : "");
        } catch (error) {
            return "Customer";
        }
    }

    async getUsernameDisplay(userId) {
        try {
            const chatInfo = await this.bot.getChat(userId);
            return chatInfo.username || 'Tidak ada';
        } catch (error) {
            return 'Tidak ada';
        }
    }

    async sendTestimoniToChannel(orderData, smsCode) {
        try {
            const now = new Date();
            const waktu = now.toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
            const userName = orderData.userName || "Customer";
            
            const hiddenNumber = orderData.number.substring(0, 4) + "***" + orderData.number.substring(orderData.number.length - 3);
            const hiddenOTP = smsCode.substring(0, 2) + "***" + smsCode.substring(smsCode.length - 1);
            const countryFlag = this.getCountryFlag(orderData.country);

            const testimoniText = `🎉 *TRANSAKSI BERHASIL* 🎉\n\n` +
                `👤 Customer: ${userName}\n` +
                `📧 Layanan: ${orderData.serviceName}\n` +
                `${countryFlag} Negara: ${orderData.country}\n` +
                `📱 Nomor: +${hiddenNumber}\n` +
                `🔑 Kode: ${hiddenOTP}\n` +
                `💰 Harga: Rp ${orderData.price.toLocaleString('id-ID')}\n` +
                `⚡ Status: Sukses Instan\n` +
                `📅 Waktu: ${waktu}\n\n` +
                `🤖 *Sistem Auto 24/7*\n` +
                `✅ Proses cepat & aman\n` +
                `✅ SMS masuk langsung\n` +
                `✅ Refund otomatis jika gagal\n\n` +
                `📞 Order sekarang juga!`;

            await this.bot.sendMessage(this.config.TESTIMONI_CHANNEL, testimoniText, {
                parse_mode: 'Markdown'
            });

        } catch (error) {
            console.error('Error sending testimoni to channel:', error.message);
        }
    }

    getOrderErrorMessage(orderResponse) {
        if (!orderResponse) {
            return {
                message: "Provider tidak merespons. Coba lagi nanti.",
                type: "network",
                solution: "Coba lagi dalam beberapa menit atau hubungi admin."
            };
        }
        
        const errorMsg = orderResponse?.data?.msg || orderResponse?.message || '';
        const lowerMsg = errorMsg.toLowerCase();
        
        if (lowerMsg.includes('restocked') || lowerMsg.includes('restock') || 
            lowerMsg.includes('stock') && lowerMsg.includes('admin')) {
            return {
                message: errorMsg,
                type: "restock",
                solution: "Layanan sedang restock. Coba layanan lain atau tunggu 10-30 menit."
            };
        }
        
        if (lowerMsg.includes('insufficient') || lowerMsg.includes('balance') ||
            lowerMsg.includes('saldo') || lowerMsg.includes('kredit')) {
            return {
                message: errorMsg,
                type: "provider_balance",
                solution: "Saldo provider habis. Hubungi admin untuk informasi lebih lanjut."
            };
        }
        
        if (lowerMsg.includes('service') && (lowerMsg.includes('not available') || 
            lowerMsg.includes('unavailable') || lowerMsg.includes('disabled'))) {
            return {
                message: errorMsg,
                type: "service_down",
                solution: "Layanan tidak tersedia sementara. Coba lagi dalam 15-30 menit."
            };
        }
        
        if (lowerMsg.includes('no numbers') || lowerMsg.includes('numbers not available')) {
            return {
                message: errorMsg,
                type: "no_numbers",
                solution: "Nomor habis untuk layanan ini. Coba negara lain atau tunggu restock."
            };
        }
        
        return {
            message: errorMsg || "Gagal order nomor dari provider",
            type: "generic",
            solution: "Coba lagi dalam beberapa menit atau hubungi admin."
        };
    }

    getIndonesianTimestamp() {
        const now = new Date();
        const options = {
            timeZone: 'Asia/Jakarta',
            day: '2-digit',
            month: '2-digit', 
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        };
        
        const jakartaTime = now.toLocaleString('id-ID', options);
        return jakartaTime.replace(', ', ' ');
    }

    getIndonesianTime() {
        const now = new Date();
        const options = {
            timeZone: 'Asia/Jakarta',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        };
        
        const jakartaTime = now.toLocaleString('id-ID', options);
        const [date, time] = jakartaTime.split(' ');
        
        return {
            date: date,
            time: time,
            full: jakartaTime,
            dateOnly: date,
            timeOnly: time
        };
    }
}

const bot = new VirtuSIMBot();

process.on('SIGINT', () => {
    console.log('🛑 Bot shutting down...');
    bot.activeMonitors.forEach(monitor => clearInterval(monitor));
    bot.userLocks.clear();
    bot.pendingOrders.clear();
    bot.refundLocks.clear();
    process.exit(0);
});

console.log('🚀 VirtuSIM Bot dimulai dengan arsitektur tingkat perusahaan');