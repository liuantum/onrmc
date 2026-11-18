import { PrismaClient, Prisma } from '@prisma/client';
export const prisma = new PrismaClient();
export type Tx = Prisma.TransactionClient;
export const num = (d: Prisma.Decimal | number | null | undefined) => (d == null ? 0 : Number(d));
