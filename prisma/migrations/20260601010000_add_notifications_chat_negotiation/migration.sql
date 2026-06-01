-- Add booking negotiation, notification, chat, and private profile-image path support.

ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'negotiating';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'accepted';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'rejected';
ALTER TYPE "BookingStatus" ADD VALUE IF NOT EXISTS 'payment_pending';

ALTER TABLE freelancer_profiles
  ADD COLUMN IF NOT EXISTS profile_image_path TEXT;

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  link_url TEXT,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_rooms (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE ON UPDATE CASCADE,
  customer_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  freelancer_id TEXT NOT NULL REFERENCES freelancer_profiles(id) ON UPDATE CASCADE,
  last_message_at TIMESTAMP(3) WITHOUT TIME ZONE,
  created_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS booking_offers (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE ON UPDATE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  receiver_id TEXT NOT NULL REFERENCES users(id) ON UPDATE CASCADE,
  amount INTEGER NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  responded_at TIMESTAMP(3) WITHOUT TIME ZONE,
  created_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT booking_offers_amount_chk CHECK (amount > 0),
  CONSTRAINT booking_offers_status_chk CHECK (status in ('pending', 'accepted', 'rejected', 'cancelled'))
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE ON UPDATE CASCADE,
  sender_id TEXT REFERENCES users(id) ON UPDATE CASCADE,
  message TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  offer_id TEXT REFERENCES booking_offers(id) ON UPDATE CASCADE,
  is_read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT chat_messages_type_chk CHECK (message_type in ('text', 'system', 'offer'))
);

CREATE INDEX IF NOT EXISTS notifications_user_id_is_read_created_at_idx ON notifications(user_id, is_read, created_at);
CREATE INDEX IF NOT EXISTS chat_rooms_customer_id_idx ON chat_rooms(customer_id);
CREATE INDEX IF NOT EXISTS chat_rooms_freelancer_id_idx ON chat_rooms(freelancer_id);
CREATE INDEX IF NOT EXISTS chat_rooms_last_message_at_idx ON chat_rooms(last_message_at);
CREATE INDEX IF NOT EXISTS booking_offers_booking_id_status_idx ON booking_offers(booking_id, status);
CREATE INDEX IF NOT EXISTS booking_offers_receiver_id_status_idx ON booking_offers(receiver_id, status);
CREATE INDEX IF NOT EXISTS chat_messages_room_id_created_at_idx ON chat_messages(room_id, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_sender_id_idx ON chat_messages(sender_id);

DROP TRIGGER IF EXISTS chat_rooms_set_updated_at ON chat_rooms;
CREATE TRIGGER chat_rooms_set_updated_at BEFORE UPDATE ON chat_rooms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS booking_offers_set_updated_at ON booking_offers;
CREATE TRIGGER booking_offers_set_updated_at BEFORE UPDATE ON booking_offers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
