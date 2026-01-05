const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ⚠️ استبدل هذا بالمفتاح الحقيقي من Render
const DATABASE_SECRETS = process.env.DATABASE_SECRETS;
const DATABASE_URL = process.env.DATABASE;

// دالة للكتابة إلى Firebase
async function writeToFirebase(path, data) {
    const url = `${DATABASE_URL}${path}.json?auth=${DATABASE_SECRETS}`;
    
    try {
        const response = await axios.put(url, data);
        console.log('✅ تم الكتابة إلى Firebase');
        return response.data;
    } catch (error) {
        console.error('❌ خطأ في الكتابة إلى Firebase:', error.message);
        throw error;
    }
}

// دالة لجلب المانجا من صفحة
async function scrapeMangaFromPage(pageNum) {
    try {
        const url = `https://azoramoon.com/page/${pageNum}/`;
        console.log(`📥 جلب الصفحة: ${url}`);
        
        const response = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const $ = cheerio.load(response.data);
        
        const mangaList = [];
        
        $('.page-item-detail.manga').each((i, element) => {
            const $el = $(element);
            const title = $el.find('.post-title h3 a').text().trim();
            const mangaUrl = $el.find('.post-title h3 a').attr('href');
            const coverUrl = $el.find('.item-thumb img').attr('src');
            const latestChapter = $el.find('.chapter-item .chapter a').text().trim();
            
            if (title && mangaUrl) {
                // توليد معرف فريد من الرابط
                const mangaId = mangaUrl.split('/series/')[1]?.replace(/\//g, '_') || `manga_${Date.now()}_${i}`;
                
                mangaList.push({
                    id: mangaId,
                    title,
                    url: mangaUrl,
                    cover: coverUrl,
                    latestChapter,
                    status: 'pending',
                    addedAt: Date.now()
                });
            }
        });
        
        return mangaList;
    } catch (error) {
        console.error(`❌ خطأ في الصفحة ${pageNum}:`, error.message);
        return [];
    }
}

// API لبدء الجلب
app.get('/start-scraping', async (req, res) => {
    try {
        const { pages = 1 } = req.query;
        console.log(`🚀 بدء جلب ${pages} صفحات...`);
        
        const allManga = [];
        
        for (let page = 1; page <= pages; page++) {
            const manga = await scrapeMangaFromPage(page);
            allManga.push(...manga);
            
            // تأخير بين الصفحات
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        console.log(`✅ تم جلب ${allManga.length} مانجا`);
        
        // حفظ كل مانجا في Firebase
        for (const manga of allManga) {
            // حفظ في HomeManga
            await writeToFirebase(`HomeManga/${manga.id}`, {
                title: manga.title,
                url: manga.url,
                cover: manga.cover,
                latestChapter: manga.latestChapter,
                status: 'pending_chapters',
                scrapedAt: Date.now()
            });
            
            // إنشاء مهمة للبوت الثاني
            await writeToFirebase(`Jobs/${manga.id}`, {
                mangaUrl: manga.url,
                status: 'waiting',
                createdAt: Date.now()
            });
            
            console.log(`📝 تم حفظ: ${manga.title}`);
        }
        
        res.json({
            success: true,
            message: `تم جلب ${allManga.length} مانجا وحفظها`,
            mangaCount: allManga.length
        });
        
    } catch (error) {
        console.error('❌ خطأ:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// صفحة الاختبار
app.get('/', (req, res) => {
    res.send(`
        <h1>✅ البوت 1 يعمل</h1>
        <p>استخدم <a href="/start-scraping?pages=1">/start-scraping?pages=1</a> لبدء الجلب</p>
        <p>Firebase Secrets: ${DATABASE_SECRETS ? '✅ موجود' : '❌ مفقود'}</p>
    `);
});

// تشغيل السيرفر
app.listen(PORT, () => {
    console.log(`✅ البوت 1 يعمل على المنفذ ${PORT}`);
    console.log(`🔗 استخدم /start-scraping?pages=3 لبدء الجلب`);
});
