-- Re-runnable because assistant setup reapplies its forward migrations.
DO $$ BEGIN
 IF to_regclass('assistant.documents') IS NOT NULL THEN
  PERFORM set_config('row_security','off',true);
  LOCK TABLE assistant.documents IN ACCESS EXCLUSIVE MODE;
  IF EXISTS(SELECT 1 FROM assistant.documents) THEN
   RAISE EXCEPTION 'Reserved documents contains records; reconcile before retirement';
  END IF;
  DROP TABLE assistant.documents;
 END IF;
END $$;
