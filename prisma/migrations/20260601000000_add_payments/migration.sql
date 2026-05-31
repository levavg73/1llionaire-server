-- CreateEnum
CREATE TYPE "PaymentStatusToss" AS ENUM ('READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT', 'DONE', 'CANCELED', 'PARTIAL_CANCELED', 'ABORTED', 'EXPIRED');

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "payment_key" TEXT,
    "amount" INTEGER NOT NULL,
    "method" TEXT,
    "status" "PaymentStatusToss" NOT NULL DEFAULT 'READY',
    "requested_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "failure_code" TEXT,
    "failure_message" TEXT,
    "raw_response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_booking_id_key" ON "payments"("booking_id");
CREATE UNIQUE INDEX "payments_order_id_key" ON "payments"("order_id");
CREATE UNIQUE INDEX "payments_payment_key_key" ON "payments"("payment_key");
CREATE INDEX "payments_booking_id_idx" ON "payments"("booking_id");
CREATE INDEX "payments_order_id_idx" ON "payments"("order_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
