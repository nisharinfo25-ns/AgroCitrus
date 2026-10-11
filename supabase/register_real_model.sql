-- ==========================================================================
-- CitrusGuard - register the REAL dataset and the REAL trained model
-- ==========================================================================
-- GENERATED FILE - do not hand-edit.
-- Regenerate with:  python scripts/generate_model_registration.py
--
-- Every literal below was read out of:
--   models/production/config.json   (exported bundle manifest)
--   data/citrus/raw/manifest.json   (verified dataset manifest)
--   reports/training-report.json    (measured evaluation report)
--
-- This file is IDEMPOTENT and safe to run repeatedly. It does NOT create
-- tables; apply supabase/combined_migration.sql first (or use
-- supabase/apply_all.sql, which does both in one paste).
--
-- It registers the model that is already trained and verified on disk. It
-- creates no placeholder and asserts no unmeasured accuracy.
-- ==========================================================================

begin;

-- --------------------------------------------------------------------------
-- 1. dataset_metadata - the verified public dataset
-- --------------------------------------------------------------------------
insert into public.dataset_metadata (
  dataset_name, version, source_url, landing_page, license, license_url, doi,
  attribution, checksum, image_count, class_count, classes, parts,
  counts_by_part, status, storage_path, downloaded_at, metadata
) values (
  'citrus-fruits-leaves',
  '2',
  'https://data.mendeley.com/public-api/zip/3f83gxmv57/download/2',
  'https://data.mendeley.com/datasets/3f83gxmv57/2',
  'CC BY 4.0',
  'https://creativecommons.org/licenses/by/4.0',
  '10.17632/3f83gxmv57.2',
  'Rauf, H. T., Saleem, B. A., Patel, H., & Aftab, S. (2019). "A Citrus Fruits and Leaves Dataset for Detection and Classification of Citrus Diseases through Machine Learning." Data in Brief. Dataset published on Mendeley Data, version 2.',
  'fc82592e9caebda988b278f0f2f965dbd0ae1464f6d920aa4ca9654da7ab19f7',
  759,
  6,
  array['Black Spot', 'Canker', 'Greening', 'Healthy', 'Melanose', 'Scab']::text[],
  array['Fruits', 'Leaves']::text[],
  '{
  "Fruits": {
    "Black Spot": 19,
    "Canker": 78,
    "Greening": 16,
    "Healthy": 22,
    "Scab": 15
  },
  "Leaves": {
    "Black Spot": 171,
    "Canker": 163,
    "Greening": 204,
    "Healthy": 58,
    "Melanose": 13
  }
}'::jsonb,
  'ready',
  'https://data.mendeley.com/public-api/zip/3f83gxmv57/download/2',
  '2026-09-30T10:01:45.074420+00:00',
  '{
  "manifest_version": 1,
  "checksum_kind": "content-sha256",
  "healthy": true,
  "corrupt": [],
  "unsupported": [],
  "duplicates": [],
  "split": {
    "ratios": {
      "train": 0.7,
      "validation": 0.15,
      "test": 0.15
    }
  }
}'::jsonb
)
on conflict (dataset_name, version) do update set
  source_url       = excluded.source_url,
  landing_page     = excluded.landing_page,
  license          = excluded.license,
  license_url      = excluded.license_url,
  doi              = excluded.doi,
  attribution      = excluded.attribution,
  checksum         = excluded.checksum,
  image_count      = excluded.image_count,
  class_count      = excluded.class_count,
  classes          = excluded.classes,
  parts            = excluded.parts,
  counts_by_part   = excluded.counts_by_part,
  status           = excluded.status,
  storage_path     = excluded.storage_path,
  downloaded_at    = excluded.downloaded_at,
  metadata         = excluded.metadata,
  updated_at       = now();

-- --------------------------------------------------------------------------
-- 2. model_versions - the exported bundle, marked production
-- --------------------------------------------------------------------------
-- `model_versions_single_production_idx` allows only ONE production row per
-- model_name, so any previous production row for this model is demoted to
-- 'candidate' first. That is what makes this re-runnable.
update public.model_versions
   set status = 'candidate',
       promoted_at = null,
       updated_at = now()
 where model_name = %s
   and version <> %s
   and status = 'production';

insert into public.model_versions (
  model_name, version, dataset_id, dataset_version, model_architecture,
  storage_path, classes, classes_by_part, input_size, preprocessing_method,
  validation_accuracy, test_accuracy, model_checksum, trained_at, promoted_at,
  part_summary, severity_support, training_report_path, status, notes
) values (
  'citrusguard-cnn',
  'v2',
  (select id from public.dataset_metadata where dataset_name = 'citrus-fruits-leaves' and version = '2'),
  '2',
  'mobilenet_v2',
  'versions/v2',
  array['Black Spot', 'Canker', 'Greening', 'Healthy', 'Melanose', 'Scab']::text[],
  '{
  "part_fruit": [
    "Black Spot",
    "Canker",
    "Greening",
    "Healthy",
    "Scab"
  ],
  "part_leaf": [
    "Black Spot",
    "Canker",
    "Greening",
    "Healthy",
    "Melanose"
  ]
}'::jsonb,
  array[224, 224]::integer[],
  'mobilenet_v2_imagenet',
  0.800000011920929,
  0.7,
  '8ee113fbf9b3277827fb77c62aa0fa8be07951d511956ada70245ffc92517f10',
  '2026-10-04T07:09:35.427100+00:00',
  now(),
  '{
  "Fruits": {
    "accuracy": 0.7,
    "macro_precision": 0.44666666666666666,
    "macro_recall": 0.5151515151515151,
    "macro_f1": 0.4481987577639751,
    "weighted_f1": 0.6554037267080746,
    "test_images": 20,
    "per_class": {
      "Black Spot": {
        "precision": 0.0,
        "recall": 0.0,
        "f1_score": 0.0,
        "support": 2
      },
      "Canker": {
        "precision": 0.8333333333333334,
        "recall": 0.9090909090909091,
        "f1_score": 0.8695652173913043,
        "support": 11
      },
      "Greening (Huanglongbing)": {
        "precision": 0.0,
        "recall": 0.0,
        "f1_score": 0.0,
        "support": 2
      },
      "Healthy": {
        "precision": 1.0,
        "recall": 0.6666666666666666,
        "f1_score": 0.8,
        "support": 3
      },
      "Scab": {
        "precision": 0.4,
        "recall": 1.0,
        "f1_score": 0.5714285714285714,
        "support": 2
      }
    },
    "confusion_matrix": [
      [
        0,
        1,
        0,
        0,
        1
      ],
      [
        1,
        10,
        0,
        0,
        0
      ],
      [
        0,
        0,
        0,
        0,
        2
      ],
      [
        0,
        1,
        0,
        2,
        0
      ],
      [
        0,
        0,
        0,
        0,
        2
      ]
    ],
    "classes": null
  },
  "Leaves": {
    "accuracy": 0.9090909090909091,
    "macro_precision": 0.9413898601398601,
    "macro_recall": 0.9196666666666665,
    "macro_f1": 0.9284868451155341,
    "weighted_f1": 0.9089955491774298,
    "test_images": 88,
    "per_class": {
      "Black Spot": {
        "precision": 0.9545454545454546,
        "recall": 0.84,
        "f1_score": 0.8936170212765957,
        "support": 25
      },
      "Canker": {
        "precision": 0.8461538461538461,
        "recall": 0.9166666666666666,
        "f1_score": 0.88,
        "support": 24
      },
      "Greening (Huanglongbing)": {
        "precision": 0.90625,
        "recall": 0.9666666666666667,
        "f1_score": 0.9354838709677419,
        "support": 30
      },
      "Healthy": {
        "precision": 1.0,
        "recall": 0.875,
        "f1_score": 0.9333333333333333,
        "support": 8
      },
      "Melanose": {
        "precision": 1.0,
        "recall": 1.0,
        "f1_score": 1.0,
        "support": 1
      }
    },
    "confusion_matrix": [
      [
        21,
        3,
        1,
        0,
        0
      ],
      [
        1,
        22,
        1,
        0,
        0
      ],
      [
        0,
        1,
        29,
        0,
        0
      ],
      [
        0,
        0,
        1,
        7,
        0
      ],
      [
        0,
        0,
        0,
        0,
        1
      ]
    ],
    "classes": null
  }
}'::jsonb,
  '{
  "enabled": false,
  "reason": "The published dataset has no severity labels (no early/moderate/severe annotations), so a severity model would have to be invented. The pipeline and the database column exist so one can be trained later."
}'::jsonb,
  'reports/training-report.json',
  'production',
  'Registered by scripts/generate_model_registration.py from the exported bundle at models/production/config.json. Artefacts: part_fruit=part_fruit.keras, part_leaf=part_leaf.keras. Per-part measured accuracy: Fruits=0.7, Leaves=0.9090909090909091. Mean test accuracy over 108 held-out images: 0.8045454545454545.'
)
on conflict (model_name, version) do update set
  dataset_id            = excluded.dataset_id,
  dataset_version       = excluded.dataset_version,
  model_architecture    = excluded.model_architecture,
  storage_path          = excluded.storage_path,
  classes               = excluded.classes,
  classes_by_part       = excluded.classes_by_part,
  input_size            = excluded.input_size,
  preprocessing_method  = excluded.preprocessing_method,
  validation_accuracy   = excluded.validation_accuracy,
  test_accuracy         = excluded.test_accuracy,
  model_checksum        = excluded.model_checksum,
  trained_at            = excluded.trained_at,
  promoted_at           = now(),
  part_summary          = excluded.part_summary,
  severity_support      = excluded.severity_support,
  training_report_path  = excluded.training_report_path,
  status                = 'production',
  notes                 = excluded.notes,
  updated_at            = now();

-- --------------------------------------------------------------------------
-- 3. show what was registered
-- --------------------------------------------------------------------------
select model_name,
       version,
       status,
       storage_path,
       model_architecture,
       input_size,
       test_accuracy,
       validation_accuracy,
       left(model_checksum, 16) || '...' as model_checksum,
       classes
  from public.model_versions
 where model_name = 'citrusguard-cnn'
 order by created_at desc;

commit;
