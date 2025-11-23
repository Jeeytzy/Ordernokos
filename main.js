/* main.js (updated) */
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs').promises;
const fse = require('fs-extra');
const path = require('path');
const QRCode = require('qrcode');
const qs = require('querystring');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { EventEmitter } = require('events');
const { createAxiosInstance } = require('./proxy-helper');

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
            BOT_TOKEN: process.env.BOT_TOKEN || '8493786090:AAH4VxtRTMFU6lhHwnEBVOeaBFnXV5vPGG8',
            VIRTUSIM_API_KEY: process.env.VIRTUSIM_API_KEY || 'PoRuVqUIzE5mwF38sC9cf60krtvHJY',
            API_BASE_URL: process.env.API_BASE_URL || 'https://virtusim.com/api/v2/json.php',
            MARKUP_PROFIT: parseInt(process.env.MARKUP_PROFIT || '2000'),
            MAX_CHECK_ATTEMPTS: parseInt(process.env.MAX_CHECK_ATTEMPTS || '20'),
            CIAATOPUP_API_KEY: process.env.CIAATOPUP_API_KEY || 'CiaaTopUp_61c141rrxlhep5b6',
            CIAATOPUP_BASE_URL: process.env.CIAATOPUP_BASE_URL || 'https://ciaatopup.my.id',
            TESTIMONI_CHANNEL: process.env.TESTIMONI_CHANNEL || '@MarketplaceclCretatorID',
            OWNER_ID: parseInt(process.env.OWNER_ID || '7804463533')
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
            'Germany': '🇩���',
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
            'Netherlands': '🇳���',
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
            return name.replace(/[_*[^
]()~`>#+=|{}.!-]/g, '\$&');
        };
        
        const username = msg.from.username ? '@' + sanitizeName(msg.from.username) : 'Tidak ada';
        
        const welcomeText = user ? 
            `\`
            `\
            `👋 Selamat Datang Kembali!\n\nHalo ${msg.from.first_name}! Senang melihat Anda lagi.\n\n` :
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
            `Pilih menu di bawah\`;

        await this.bot.sendPhoto(msg.chat.id, this.botLogo, {
            caption: fullText,
            reply_markup: keyboard,
            parse_mode: 'Markdown'
        });
    }

    // ... rest of main.js remains unchanged except apiRequest and ciaaTopUpRequest (both updated above) ...

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
