-- Enrollment system: student registry + extended enrollment tracking

CREATE TABLE IF NOT EXISTS edu_students (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE(client_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_edu_students_client ON edu_students(client_id);

-- Extend edu_enrollments with structured links and payment info
ALTER TABLE edu_enrollments ADD COLUMN student_id INTEGER;
ALTER TABLE edu_enrollments ADD COLUMN course_id INTEGER;
ALTER TABLE edu_enrollments ADD COLUMN fee_amount REAL;
ALTER TABLE edu_enrollments ADD COLUMN fee_currency TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE edu_enrollments ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE edu_enrollments ADD COLUMN payment_reference TEXT NOT NULL DEFAULT '';

-- Duplicate prevention: one student per course (partial index, only when both are set)
CREATE UNIQUE INDEX IF NOT EXISTS idx_edu_enroll_unique
  ON edu_enrollments(client_id, student_id, course_id)
  WHERE student_id IS NOT NULL AND course_id IS NOT NULL;
