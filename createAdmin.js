const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const admin = await prisma.user.create({
    data: {
      name: 'MGdigi Admin',
      phone: '9000000000',
      referralCode: 'ADMIN01',
      role: 'admin',
      kycStatus: 'verified',
      pointsWallet: { create: { balance: 0, lifetime: 0 } },
      earningsWallet: { create: { balance: 0, lifetime: 0 } }
    }
  })
  console.log('✅ Admin created!')
  console.log('Phone:', admin.phone)
  console.log('Role:', admin.role)
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect())