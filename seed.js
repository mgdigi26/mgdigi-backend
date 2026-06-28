const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  await prisma.campaign.createMany({
    data: [
      { name: 'Campaign A', type: 'Short Video', pointsReq: 10, rewardAmt: 10, sortOrder: 1, descEn: '30-second MGdigi intro clip on WhatsApp Status', descHi: 'WhatsApp Status पर 30 सेकंड का MGdigi क्लिप', descMr: 'WhatsApp Status वर 30 सेकंद MGdigi क्लिप' },
      { name: 'Campaign B', type: 'Standard', pointsReq: 25, rewardAmt: 25, sortOrder: 2, descEn: 'MGdigi EV feature video on WhatsApp Status', descHi: 'WhatsApp Status पर MGdigi EV वीडियो', descMr: 'WhatsApp Status वर MGdigi EV व्हिडिओ' },
      { name: 'Campaign C', type: 'Premium', pointsReq: 50, rewardAmt: 50, sortOrder: 3, descEn: '3-day MGdigi campaign series', descHi: '3 दिन MGdigi अभियान श्रृंखला', descMr: '3 दिवस MGdigi मोहीम मालिका' },
      { name: 'Campaign D', type: 'High Reach', pointsReq: 100, rewardAmt: 100, sortOrder: 4, descEn: '5 WhatsApp groups with verified reach', descHi: 'सत्यापित पहुंच के साथ 5 WhatsApp ग्रुप', descMr: 'पडताळलेल्या पोहोचसह 5 WhatsApp गट' },
      { name: 'Campaign E', type: 'Mega', pointsReq: 260, rewardAmt: 260, sortOrder: 5, descEn: 'Full influencer campaign across all platforms', descHi: 'सभी प्लेटफॉर्म पर पूर्ण इन्फ्लुएंसर अभियान', descMr: 'सर्व व्यासपीठांवर पूर्ण इन्फ्लुएन्सर मोहीम' },
    ]
  })
  console.log('✅ Campaigns seeded successfully!')
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())