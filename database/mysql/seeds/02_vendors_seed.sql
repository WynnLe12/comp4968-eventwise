-- Vendor seed (Feature 5): vendors plus the expenses and payments linked to them.
-- LOCAL DEVELOPMENT AND TESTS ONLY. Needs 01_base_seed.sql (events 1-2, categories 1-9).
--
-- Event 1: 8 vendors covering every booking status. Event 2: 2 vendors.
-- The expenses here exist to test vendor totals. If the expenses seed (Feature 4)
-- adds its own rows, merge these into it rather than keeping two copies.
--
-- Expected results of the vendor list query for event 1 (sorted by name):
--
--   vendor                 booking / contract          paid     balance    next due     case covered
--   Blue Note Collective   BOOKED / SIGNED              0.00    1800.00   2027-07-10   unpaid expense
--   Fleur & Fern           BOOKED / SIGNED            850.00    2000.00   2027-08-20   one payment + a refund
--   Golden Hour Cars       DECLINED / CANCELLED         0.00    null      null         declined, no expenses
--   Lumen Photography      BOOKED / SIGNED           2100.00    2100.00   2027-08-01   several payments, one expense
--   Paperfolk Studio       BOOKED / SIGNED            640.00       0.00   null         fully paid
--   Rosewood Rentals       RESEARCHING / NOT_STARTED    0.00    null      null         no expenses (plain delete)
--   Silk & Thread Bridal   QUOTED / PENDING             0.00    3100.00   null         expense with no due date
--   The Willow House       BOOKED / SIGNED           5000.00    7800.00   2027-06-15   fully paid expense skipped for due date
--
-- Event 1 also has an expense with no vendor (marriage licence) that must not affect any vendor.
-- Event 2: DJ Nova paid 200.00, balance 400.00, next due 2027-02-01; Party Pals Catering paid 0.00.

USE eventwise;

-- Reset this file's rows. Deleting an expense also deletes its payments.
DELETE FROM expenses WHERE event_id IN (1, 2);
DELETE FROM vendors  WHERE event_id IN (1, 2);

INSERT INTO vendors
 (vendor_id, event_id, name, category, contact_name, email, phone,
  quote_amount, contract_total, booking_status, contract_status, notes)
VALUES
 (1, 1, 'The Willow House', 'Venue & Catering', 'Grace Hill', 'events@thewillowhouse.example', '(555) 014-2280',
     12800.00, 12800.00, 'BOOKED', 'SIGNED', 'Final headcount due 30 days before the event.'),
 (2, 1, 'Lumen Photography', 'Photo & Video', 'Daniel Park', 'hello@lumenphoto.example', '(555) 014-3391',
     4200.00, 4200.00, 'BOOKED', 'SIGNED', 'Includes engagement shoot.'),
 (3, 1, 'Fleur & Fern', 'Flowers & Decor', 'Priya Shah', 'studio@fleurandfern.example', '(555) 014-4402',
     2850.00, 2850.00, 'BOOKED', 'SIGNED', 'Refunded 150.00 after the arch was removed from the order.'),
 (4, 1, 'Blue Note Collective', 'Music & Entertainment', 'Marcus Reid', 'bookings@bluenote.example', '(555) 014-5513',
     1800.00, 1800.00, 'BOOKED', 'SIGNED', NULL),
 (5, 1, 'Paperfolk Studio', 'Stationery', 'Lena Novak', 'hi@paperfolk.example', NULL,
     640.00, 640.00, 'BOOKED', 'SIGNED', 'Invitations and place cards.'),
 (6, 1, 'Silk & Thread Bridal', 'Attire & Beauty', 'Ana Ruiz', 'appointments@silkandthread.example', '(555) 014-6624',
     3200.00, 3100.00, 'QUOTED', 'PENDING', 'Contract sent with a 100.00 discount.'),
 (7, 1, 'Golden Hour Cars', 'Other', 'Tom Baker', NULL, '(555) 014-7735',
     950.00, NULL, 'DECLINED', 'CANCELLED', 'Marked as cancelled; went with the venue''s shuttle.'),
 (8, 1, 'Rosewood Rentals', 'Other', NULL, NULL, NULL,
     NULL, NULL, 'RESEARCHING', 'NOT_STARTED', NULL),
 (9, 2, 'Party Pals Catering', 'Food', 'Jordan Lee', 'orders@partypals.example', '(555) 014-8846',
     800.00, NULL, 'QUOTED', 'NOT_STARTED', NULL),
 (10, 2, 'DJ Nova', 'Entertainment', 'Nova Kim', 'dj@nova.example', NULL,
     600.00, 600.00, 'BOOKED', 'SIGNED', NULL);

INSERT INTO expenses (expense_id, event_id, category_id, vendor_id, description, committed_amount, due_date) VALUES
 (1, 1, 1, 1,    'Venue deposit',         5000.00, '2027-01-15'),  -- fully paid, so skipped for next due
 (2, 1, 1, 1,    'Venue balance',         7800.00, '2027-06-15'),  -- unpaid
 (3, 1, 2, 2,    'Photography package',   4200.00, '2027-08-01'),  -- several payments
 (4, 1, 4, 3,    'Florals',               2850.00, '2027-08-20'),  -- one deposit and a refund
 (5, 1, 5, 4,    'Band',                  1800.00, '2027-07-10'),  -- no payments
 (6, 1, 6, 5,    'Invitations',            640.00, '2027-03-01'),  -- fully paid
 (7, 1, 3, 6,    'Dress alterations',      400.00, NULL),          -- no due date
 (8, 1, 7, NULL, 'Marriage licence',       150.00, '2027-05-01'),  -- no vendor
 (9, 2, 9, 10,   'DJ set',                 600.00, '2027-02-01');  -- other event

INSERT INTO expense_payments (expense_id, amount, paid_at, payment_type, notes) VALUES
 (1, 5000.00, '2026-10-01', 'DEPOSIT', 'Venue deposit'),
 (3, 1000.00, '2026-10-05', 'DEPOSIT', NULL),
 (3, 1100.00, '2026-11-02', 'PAYMENT', NULL),
 (4, 1000.00, '2026-10-12', 'DEPOSIT', NULL),
 (4,  150.00, '2026-10-20', 'REFUND',  'Arch removed from order'),
 (6,  640.00, '2026-10-15', 'PAYMENT', 'Paid in full'),
 (8,  150.00, '2026-11-01', 'PAYMENT', 'City hall fee'),
 (9,  200.00, '2026-11-03', 'DEPOSIT', NULL);
