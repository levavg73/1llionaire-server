-- Voit Supabase/Postgres initialization SQL
-- Generated from prisma/schema.prisma for initial Supabase SQL Editor setup.
-- Important:
-- 1) Prefer Prisma migrations as the source of truth: `pnpm prisma migrate deploy`.
-- 2) Do not run this on a database where Prisma already created these objects.
-- 3) IDs are TEXT because the Prisma schema uses @default(cuid()). Prisma Client supplies IDs at insert time.

begin;

-- Optional but useful for search indexes.
create extension if not exists pg_trgm;

-- Enums
create type "UserType" as enum ('customer', 'freelancer', 'admin');
create type "FreelancerStatus" as enum ('draft', 'pending_review', 'approved', 'rejected', 'hidden', 'suspended');
create type "RequestStatus" as enum ('submitted', 'reviewing', 'recommending', 'recommended', 'consulting', 'booked', 'completed', 'reviewed', 'canceled', 'disputed');
create type "RecommendationStatus" as enum ('draft', 'sent', 'viewed', 'consultation_requested', 'selected', 'rejected');
create type "QuoteStatus" as enum ('proposed', 'accepted', 'rejected', 'expired', 'canceled');
create type "BookingStatus" as enum ('pending', 'confirmed', 'completed', 'canceled', 'disputed');
create type "PaymentStatus" as enum ('unpaid', 'deposit_paid', 'fully_paid', 'refunded', 'failed');
create type "SettlementStatus" as enum ('pending', 'scheduled', 'completed', 'held', 'failed');
create type "ReviewStatus" as enum ('pending', 'published', 'hidden', 'reported');

create table users (
  id text primary key,
  user_type "UserType" not null,
  name text not null,
  email text not null unique,
  password_hash text not null,
  phone text,
  provider text,
  provider_id text,
  is_active boolean not null default true,
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp
);

create table customer_profiles (
  id text primary key,
  user_id text not null unique references users(id) on delete cascade on update cascade,
  customer_type text,
  company_name text,
  department text,
  manager_name text,
  memo text,
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp
);

create table freelancer_profiles (
  id text primary key,
  user_id text not null unique references users(id) on delete cascade on update cascade,
  display_name text,
  profile_image_url text,
  headline text,
  bio text,
  region text,
  available_regions text[] not null default array[]::text[],
  categories text[] not null default array[]::text[],
  styles text[] not null default array[]::text[],
  career_years integer,
  base_price_min integer,
  base_price_max integer,
  languages text[] not null default array[]::text[],
  script_writing_available boolean not null default false,
  rehearsal_available boolean not null default false,
  travel_available boolean not null default false,
  status "FreelancerStatus" not null default 'draft',
  voice_score double precision,
  approved_at timestamp(3) without time zone,
  rejected_reason text,
  avg_rating double precision,
  review_count integer not null default 0,
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp,
  constraint freelancer_profiles_price_range_chk check (
    base_price_min is null or base_price_max is null or base_price_min <= base_price_max
  ),
  constraint freelancer_profiles_career_years_chk check (career_years is null or career_years between 0 and 50),
  constraint freelancer_profiles_rating_chk check (avg_rating is null or avg_rating between 0 and 5)
);

create table portfolios (
  id text primary key,
  freelancer_id text not null references freelancer_profiles(id) on delete cascade on update cascade,
  portfolio_type text not null,
  title text not null,
  description text,
  media_url text not null,
  thumbnail_url text,
  category text,
  is_representative boolean not null default false,
  is_public boolean not null default true,
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp
);

create table event_requests (
  id text primary key,
  customer_id text not null references users(id) on update cascade,
  event_title text not null,
  event_type text not null,
  event_date timestamp(3) without time zone not null,
  start_time text not null,
  end_time text not null,
  region text not null,
  venue text,
  budget_min integer,
  budget_max integer,
  preferred_freelancer_type text[] not null default array[]::text[],
  preferred_styles text[] not null default array[]::text[],
  required_language text,
  script_required boolean not null default false,
  rehearsal_required boolean not null default false,
  travel_required boolean not null default false,
  attachment_url text,
  description text,
  status "RequestStatus" not null default 'submitted',
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp,
  constraint event_requests_budget_range_chk check (
    budget_min is null or budget_max is null or budget_min <= budget_max
  )
);

create table recommendations (
  id text primary key,
  request_id text not null references event_requests(id) on update cascade,
  freelancer_id text not null references freelancer_profiles(id) on update cascade,
  recommended_by text not null references users(id) on update cascade,
  recommendation_reason text,
  display_order integer not null default 0,
  status "RecommendationStatus" not null default 'draft',
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp,
  constraint recommendations_request_freelancer_key unique (request_id, freelancer_id)
);

create table quotes (
  id text primary key,
  request_id text not null references event_requests(id) on update cascade,
  freelancer_id text not null references freelancer_profiles(id) on update cascade,
  quoted_by text not null references users(id) on update cascade,
  price integer not null,
  platform_fee integer not null default 0,
  total_price integer not null,
  included_services text,
  script_included boolean not null default false,
  rehearsal_included boolean not null default false,
  travel_fee_included boolean not null default false,
  message text,
  valid_until timestamp(3) without time zone,
  status "QuoteStatus" not null default 'proposed',
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp,
  constraint quotes_price_chk check (price > 0),
  constraint quotes_fee_chk check (platform_fee >= 0 and total_price >= price)
);

create table bookings (
  id text primary key,
  request_id text references event_requests(id) on update cascade,
  customer_id text not null references users(id) on update cascade,
  freelancer_id text not null references freelancer_profiles(id) on update cascade,
  quote_id text references quotes(id) on update cascade,
  event_title text not null,
  event_date timestamp(3) without time zone not null,
  start_time text not null,
  end_time text not null,
  venue text,
  final_price integer not null,
  platform_fee integer not null default 0,
  freelancer_amount integer not null,
  booking_status "BookingStatus" not null default 'pending',
  payment_status "PaymentStatus" not null default 'unpaid',
  settlement_status "SettlementStatus" not null default 'pending',
  cancel_reason text,
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp,
  constraint bookings_amount_chk check (final_price >= 0 and platform_fee >= 0 and freelancer_amount >= 0)
);

create table reviews (
  id text primary key,
  booking_id text not null unique references bookings(id) on update cascade,
  customer_id text not null references users(id) on update cascade,
  freelancer_id text not null references freelancer_profiles(id) on update cascade,
  punctuality_score integer not null,
  voice_delivery_score integer not null,
  event_understanding_score integer not null,
  atmosphere_score integer not null,
  script_score integer not null,
  response_score integer not null,
  communication_score integer not null,
  total_score double precision not null,
  rehire_intent boolean not null,
  comment text,
  status "ReviewStatus" not null default 'pending',
  created_at timestamp(3) without time zone not null default current_timestamp,
  updated_at timestamp(3) without time zone not null default current_timestamp,
  constraint reviews_score_chk check (
    punctuality_score between 1 and 5 and
    voice_delivery_score between 1 and 5 and
    event_understanding_score between 1 and 5 and
    atmosphere_score between 1 and 5 and
    script_score between 1 and 5 and
    response_score between 1 and 5 and
    communication_score between 1 and 5 and
    total_score between 1 and 5
  )
);

create table refresh_tokens (
  id text primary key,
  user_id text not null references users(id) on delete cascade on update cascade,
  token_hash text not null,
  expires_at timestamp(3) without time zone not null,
  revoked_at timestamp(3) without time zone,
  created_at timestamp(3) without time zone not null default current_timestamp
);

-- Standard indexes from Prisma schema
create index users_email_idx on users(email);
create index users_user_type_idx on users(user_type);
create index freelancer_profiles_status_idx on freelancer_profiles(status);
create index portfolios_freelancer_id_idx on portfolios(freelancer_id);
create index event_requests_customer_id_idx on event_requests(customer_id);
create index event_requests_status_idx on event_requests(status);
create index recommendations_request_id_idx on recommendations(request_id);
create index quotes_request_id_idx on quotes(request_id);
create index quotes_freelancer_id_idx on quotes(freelancer_id);
create index bookings_customer_id_idx on bookings(customer_id);
create index bookings_freelancer_id_idx on bookings(freelancer_id);
create index bookings_booking_status_idx on bookings(booking_status);
create index bookings_payment_status_idx on bookings(payment_status);
create index reviews_freelancer_id_idx on reviews(freelancer_id);
create index reviews_status_idx on reviews(status);
create index refresh_tokens_user_id_idx on refresh_tokens(user_id);
create index refresh_tokens_token_hash_idx on refresh_tokens(token_hash);

-- Recommended additional indexes for this API's common filters/search.
create index freelancer_profiles_categories_gin_idx on freelancer_profiles using gin(categories);
create index freelancer_profiles_languages_gin_idx on freelancer_profiles using gin(languages);
create index freelancer_profiles_available_regions_gin_idx on freelancer_profiles using gin(available_regions);
create index freelancer_profiles_public_listing_idx on freelancer_profiles(status, region, avg_rating desc, review_count desc);
create index freelancer_profiles_display_name_trgm_idx on freelancer_profiles using gin(display_name gin_trgm_ops);
create index freelancer_profiles_headline_trgm_idx on freelancer_profiles using gin(headline gin_trgm_ops);
create index freelancer_profiles_bio_trgm_idx on freelancer_profiles using gin(bio gin_trgm_ops);
create index reviews_public_freelancer_idx on reviews(freelancer_id, created_at desc) where status = 'published';

-- Race-condition protection not expressible cleanly in the current Prisma schema.
create unique index bookings_one_active_per_request_idx
  on bookings(request_id)
  where request_id is not null and booking_status <> 'canceled';

create unique index bookings_one_active_per_quote_idx
  on bookings(quote_id)
  where quote_id is not null and booking_status <> 'canceled';

-- Keep updated_at fresh for manual SQL updates. Prisma also manages @updatedAt in application writes.
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = current_timestamp;
  return new;
end;
$$ language plpgsql;

create trigger users_set_updated_at before update on users for each row execute function set_updated_at();
create trigger customer_profiles_set_updated_at before update on customer_profiles for each row execute function set_updated_at();
create trigger freelancer_profiles_set_updated_at before update on freelancer_profiles for each row execute function set_updated_at();
create trigger portfolios_set_updated_at before update on portfolios for each row execute function set_updated_at();
create trigger event_requests_set_updated_at before update on event_requests for each row execute function set_updated_at();
create trigger recommendations_set_updated_at before update on recommendations for each row execute function set_updated_at();
create trigger quotes_set_updated_at before update on quotes for each row execute function set_updated_at();
create trigger bookings_set_updated_at before update on bookings for each row execute function set_updated_at();
create trigger reviews_set_updated_at before update on reviews for each row execute function set_updated_at();

commit;
