-- AlterTable
ALTER TABLE "User" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active',
ADD COLUMN     "warnings" INTEGER NOT NULL DEFAULT 0;
