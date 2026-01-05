const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT_1 || 10000;

const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE_URL;

// إعدادات النظام
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL_MINUTES || 5) * 60 * 1000;
const MAX_PAGES = parseInt(process.env.MAX_PAGES_TO_SCRAPE || 5);

// رؤوس HTTP مثبتة
const FIXED_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'ar,en-US;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache'
};

// Firebase Helper
class FirebaseHelper {
    constructor() {
        this.baseUrl = DATABASE_URL && !DATABASE_URL.endsWith('/') ? DATABASE_URL + '/' : DATABASE_URL;
        this.secret = DATABASE_SECRETS;
    }

    async read(path) {
        try {
            const url = `${this.baseUrl}${path}.json?auth=${this.secret}`;
            const response = await axios.get(url, { timeout: 10000 });
            return response.data;
        } catch (error) {
            console.log(`❌ خطأ في قراءة ${path}:`, error.message);
            return null;
        }
    }

    async write(path, data) {
        try {
            const url = `${this.baseUrl}${path}.json?auth=${this.secret}`;
            await axios.put(url, data, { 
                timeout: 10000,
                headers: { 'Content-Type': 'application/json' }
            });
            return true;
        } catch (error) {
            console.log(`❌ خطأ في كتابة ${path}:`, error.message);
            return false;
        }
    }

    async update(path, updates) {
        try {
            const current = await this.read(path) || {};
            const updated = { ...current, ...updates };
            return await this.write(path, updated);
        } catch (error) {
            return false;
        }
    }
}

const db = new FirebaseHelper();

// نظام المراقبة المستمرة
class MangaMonitor {
    constructor() {
        this.isRunning = false;
        this.lastCheck = null;
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        console.log('🚀 بدء مراقبة المانجا...');
        
        // البدء الفوري
        await this.checkForNewManga();
        
        // جدولة فحص دوري
        setInterval(() => {
            this.checkForNewManga();
        }, CHECK_INTERVAL);
    }

    async checkForNewManga() {
        console.log('\n🔍 فحص المانجا الجديدة...');
        this.lastCheck = Date.now();
        
        try {
            // جلب الصفحة الأولى فقط
            const mangaList = await this.scrapePage(1);
            
            if (mangaList.length === 0) {
                console.log('⚠️ لم يتم العثور على مانجا جديدة');
                return;
            }
            
            console.log(`📊 تم العثور على ${mangaList.length} مانجا`);
            
            // حفظ المانجا الجديدة فقط
            for (const manga of mangaList) {
                const existing = await db.read(`HomeManga/${manga.id}`);
                
                if (!existing) {
                    // مانجا جديدة
                    await this.saveNewManga(manga);
                    console.log(`✅ مانجا جديدة: ${manga.title}`);
                } else {
                    // مانجا موجودة، تحقق من التحديثات
                    await this.checkMangaUpdates(manga, existing);
                }
            }
            
        } catch (error) {
            console.error('❌ خطأ في الفحص:', error.message);
        }
    }

    async scrapePage(pageNum) {
        try {
            const url = `https://azoramoon.com/page/${pageNum}/`;
            console.log(`📥 جلب الصفحة ${pageNum}`);
            
            const response = await axios.get(url, {
                headers: FIXED_HEADERS,
                timeout: 15000
            });
            
            const $ = cheerio.load(response.data);
            const mangaList = [];
            
            // استخراج المانجا
            $('.page-item-detail.manga').each((i, element) => {
                const $el = $(element);
                const title = $el.find('.post-title h3 a').text().trim();
                const mangaUrl = $el.find('.post-title h3 a').attr('href');
                const latestChapter = $el.find('.chapter-item .chapter a').text().trim() || 'غير معروف';
                
                if (title && mangaUrl) {
                    const mangaId = crypto.createHash('md5').update(mangaUrl).digest('hex').substring(0, 12);
                    
                    mangaList.push({
                        id: mangaId,
                        title: title,
                        url: mangaUrl,
                        latestChapter: latestChapter,
                        status: 'pending',
                        detectedAt: Date.now()
                    });
                }
            });
            
            return mangaList;
            
        } catch (error) {
            console.log(`❌ خطأ في الصفحة ${pageNum}:`, error.message);
            return [];
        }
    }

    async saveNewManga(manga) {
        // حفظ في HomeManga
        await db.write(`HomeManga/${manga.id}`, {
            title: manga.title,
            url: manga.url,
            latestChapter: manga.latestChapter,
            status: 'pending_chapters',
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
        
        // إنشاء مهمة للسيرفر 2
        await db.write(`Jobs/${manga.id}`, {
            mangaId: manga.id,
            mangaUrl: manga.url,
            title: manga.title,
            status: 'pending',
            priority: 'high',
            createdAt: Date.now(),
            lastAttempt: null,
            attempts: 0
        });
        
        console.log(`📝 تم إنشاء مهمة للسيرفر 2: ${manga.title}`);
    }

    async checkMangaUpdates(newManga, existing) {
        // التحقق إذا كان هناك فصل جديد
        if (newManga.latestChapter !== existing.latestChapter) {
            console.log(`🔄 تحديث فصل: ${existing.title}`);
            console.log(`   القديم: ${existing.latestChapter}`);
            console.log(`   الجديد: ${newManga.latestChapter}`);
            
            // تحديث البيانات
            await db.update(`HomeManga/${newManga.id}`, {
                latestChapter: newManga.latestChapter,
                updatedAt: Date.now(),
                status: 'needs_update'
            });
            
            // إعلام السيرفر 2 بوجود تحديث
            await db.update(`Jobs/${newManga.id}`, {
                status: 'needs_update',
                updatedAt: Date.now()
            });
        }
    }
}

// تشغيل المراقب
const monitor = new MangaMonitor();

// APIs
app.get('/', async (req, res) => {
    const stats = await db.read('System/Stats') || {};
    
    res.json({
        server: '1 - جامع المانجا',
        status: 'running',
        monitor: monitor.isRunning ? 'active' : 'inactive',
        lastCheck: monitor.lastCheck ? new Date(monitor.lastCheck).toLocaleString() : 'never',
        stats: stats.server1 || {},
        endpoints: {
            '/start': 'بدء المراقبة',
            '/stop': 'إيقاف المراقبة',
            '/status': 'حالة النظام',
            '/scan-now': 'فحص فوري'
        }
    });
});

app.get('/start', async (req, res) => {
    await monitor.start();
    res.json({ success: true, message: 'بدأت المراقبة' });
});

app.get('/scan-now', async (req, res) => {
    await monitor.checkForNewManga();
    res.json({ success: true, message: 'تم الفحص' });
});

app.get('/status', async (req, res) => {
    const mangaCount = await db.read('HomeManga') || {};
    const jobs = await db.read('Jobs') || {};
    
    res.json({
        active: monitor.isRunning,
        totalManga: Object.keys(mangaCount).length,
        pendingJobs: Object.values(jobs).filter(j => j.status === 'pending').length,
        processingJobs: Object.values(jobs).filter(j => j.status === 'processing').length,
        lastCheck: monitor.lastCheck
    });
});

// بدء المراقبة تلقائياً
app.listen(PORT, async () => {
    console.log(`✅ السيرفر 1 يعمل على المنفذ ${PORT}`);
    console.log(`🔗 الرابط: https://server-1-zw44.onrender.com`);
    
    // بدء المراقبة عند التشغيل
    await monitor.start();
});
