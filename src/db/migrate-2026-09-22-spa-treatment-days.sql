-- Per-treatment days of the week: a treatment a salon only offers on some
-- days (a barber's "Hot towel shave -- Tue/Thu only"). Distinct from
-- spa_therapist_hours, which says when a *person* works; this says when a
-- *service* is on offer, across every therapist.
--
-- NULL = offered every day, so every existing treatment is unchanged.
-- Values are ISO day-of-week (1 = Monday .. 7 = Sunday), matching
-- spa_therapist_hours.day_of_week and EXTRACT(ISODOW ...).
--
-- The empty array is rejected rather than allowed to mean "never bookable":
-- a treatment with no days at all is a delete (status = 'inactive'), not a
-- schedule.
ALTER TABLE spa_treatment ADD COLUMN IF NOT EXISTS days_of_week INT[];
DO $$ BEGIN
  ALTER TABLE spa_treatment ADD CONSTRAINT spa_treatment_days_of_week_valid
    CHECK (
      days_of_week IS NULL
      OR (array_length(days_of_week, 1) BETWEEN 1 AND 7
          AND days_of_week <@ ARRAY[1,2,3,4,5,6,7])
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
