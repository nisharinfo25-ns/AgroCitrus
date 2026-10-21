/**
 * Domain types shared by the API layer and the React tree.
 *
 * These mirror the PostgreSQL schema and the ML worker's JSON contract. Where
 * a metric was not measured, the type is `number | null` and the UI is required
 * to render "Not available" - there is no `0` sentinel.
 */

// --------------------------------------------------------------------------
// Enumerations
// --------------------------------------------------------------------------
export type UserRole = "admin" | "user";
export type InputType = "leaf" | "fruit";
export type HealthStatus = "healthy" | "diseased";
export type PredictionState = "ok" | "low_confidence" | "rejected_quality" | "failed";
export type Severity = "early" | "moderate" | "severe";
export type DatasetStatus = "pending" | "downloading" | "validating" | "ready" | "failed";
export type ModelStatus = "candidate" | "production" | "retired" | "failed";

// --------------------------------------------------------------------------
// Database rows
// --------------------------------------------------------------------------
export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: UserRole;
  created_at: string;
  updated_at: string;
}

export interface DatasetMetadata {
  id: string;
  dataset_name: string;
  version: string;
  source_url: string;
  landing_page: string | null;
  license: string | null;
  license_url: string | null;
  doi: string | null;
  attribution: string | null;
  /** Deterministic content SHA-256. `null` until a dataset has been synced. */
  checksum: string | null;
  image_count: number | null;
  class_count: number | null;
  classes: string[];
  parts: string[];
  counts_by_part: Record<string, Record<string, number>>;
  status: DatasetStatus;
  storage_path: string | null;
  downloaded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PartSummary {
  part: string;
  classes: string[];
  class_count: number;
  training_images: number | null;
  validation_images: number | null;
  test_images: number | null;
  training_seconds: number | null;
  model_parameters: number | null;
  validation_accuracy: number | null;
  test_accuracy: number | null;
  test_macro_f1: number | null;
  confusion_matrix: number[][] | null;
  confusion_matrix_png: string | null;
  training_curves_png: string | null;
}

export interface ModelVersion {
  id: string;
  model_name: string;
  version: string;
  dataset_id: string | null;
  dataset_version: string | null;
  model_architecture: string | null;
  storage_path: string;
  classes: string[];
  classes_by_part: Record<string, string[]>;
  input_size: number[] | null;
  preprocessing_method: string | null;
  /** `null` = not measured. Never assume a number. */
  validation_accuracy: number | null;
  /** `null` = not measured. Never assume a number. */
  test_accuracy: number | null;
  model_checksum: string | null;
  trained_at: string | null;
  promoted_at: string | null;
  part_summary: Record<string, PartSummary>;
  severity_support: { enabled: boolean; reason?: string };
  training_report_path: string | null;
  status: ModelStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface DiseaseInformation {
  id: string;
  slug: string;
  display_name: string;
  applies_to: string[];
  is_healthy: boolean;
  short_description: string;
  symptoms: string[];
  prevention: string[];
  management: string[];
  reference_sources: string[];
  references?: string[];
  content_complete: boolean;
  created_at: string;
  updated_at: string;
}

export interface Scan {
  id: string;
  user_id: string;
  image_path: string;
  processed_path: string | null;
  explanation_path: string | null;
  heatmap_path: string | null;
  input_type: InputType | null;
  input_type_confidence: number | null;
  predicted_class: string | null;
  predicted_class_display: string | null;
  confidence: number;
  status: HealthStatus | null;
  prediction_state: PredictionState;
  is_low_confidence: boolean;
  severity: Severity | null;
  probabilities: Probability[];
  part_probabilities: Probability[];
  quality_metrics: QualityMetrics | null;
  explanation_note: string | null;
  model_version: string | null;
  model_name: string | null;
  dataset_version: string | null;
  latency_ms: number | null;
  error_code: string | null;
  created_at: string;
}

// --------------------------------------------------------------------------
// Prediction payload
// --------------------------------------------------------------------------
export interface Probability {
  class_name: string;
  probability: number;
}

export interface QualityCheck {
  name: string;
  passed: boolean;
  value: number;
  threshold: string;
  message: string;
}

export interface QualityMetrics {
  passed: boolean;
  sharpness: number;
  brightness: number;
  contrast: number;
  width: number;
  height: number;
  megapixels: number;
  reasons: string[];
  checks: QualityCheck[];
}

/**
 * A Grad-CAM result.
 *
 * `heatmap_path` / `overlay_path` are the storage keys as written by the ML
 * worker. The `*_url` fields are the short-lived signed URLs the UI actually
 * renders, added server-side for stored scans. Keeping both is deliberate: a
 * path with no URL is a real state (the object exists but the signature could
 * not be minted) and the UI must say so rather than render a broken image.
 */
export interface GradCamPayload {
  heatmap_path: string | null;
  overlay_path: string | null;
  /** Signed URL for `overlay_path`, or null when it could not be minted. */
  overlay_url?: string | null;
  /** Signed URL for `heatmap_path`, or null when it could not be minted. */
  heatmap_url?: string | null;
  target_layer?: string | null;
  regions?: string[];
  /**
   * Optional text. `| null` because the value comes straight from a nullable
   * database column, and widening here is honest about that rather than forcing
   * every call site to invent an empty string.
   */
  summary?: string | null;
  disclaimer?: string | null;
  error?: string | null;
}

/**
 * Stage-1 routing provenance.
 *
 *   ok          a trained Leaf-vs-Fruit router decided, above its threshold
 *   uncertain   the router scored below its threshold; NO disease head ran and
 *               NO Grad-CAM was produced, because guessing a head would turn a
 *               refusal into a fabricated diagnosis
 *   heuristic   the bundle predates the router, so the legacy peak-softmax
 *               comparison was used. A limitation, stated as one.
 *   user_selected the uploader explicitly chose leaf or fruit, so no classifier
 *               ran; the choice is recorded rather than presented as a result
 *   config_only a single-head bundle, so the part came from the config
 */
export type RoutingState = "ok" | "uncertain" | "heuristic" | "user_selected" | "config_only";

export interface PredictionPayload {
  input_type: InputType | null;
  input_type_confidence: number | null;
  predicted_class: string;
  predicted_class_display: string;
  confidence: number;
  /**
   * `null` when the pipeline refused to issue a verdict (quality rejection or
   * routing abstention). The column is nullable for exactly this reason, and a
   * rejected image must never be recorded as "diseased".
   */
  status: HealthStatus | null;
  is_low_confidence: boolean;
  min_confidence_threshold: number;
  probabilities: Probability[];
  part_probabilities: Probability[];
  quality: QualityMetrics | null;
  severity: Severity | null;
  severity_supported: boolean;
  severity_unavailable_reason: string | null;
  gradcam: GradCamPayload | null;
  model_name: string;
  model_version: string;
  dataset_version: string;
  explanation_note: string;
  latency_ms: number;
  // ---- stage-1 routing (all optional: older workers do not emit them) ---- //
  routing_state?: RoutingState;
  /** Same measurement as `input_type_confidence`, under an unambiguous name. */
  routing_confidence?: number | null;
  routing_threshold?: number | null;
  routing_method?: string | null;
  routing_message?: string | null;
  /** Same measurement as `confidence`, under an unambiguous name. */
  prediction_confidence?: number | null;
}

export interface ScanWithUrls extends Scan {
  /** Short-lived signed URLs. Regenerated per request; never persisted. */
  image_url: string | null;
  heatmap_url: string | null;
  overlay_url: string | null;
}

// --------------------------------------------------------------------------
// API envelopes
// --------------------------------------------------------------------------
export interface ApiError {
  error: { code: string; message: string; [key: string]: unknown };
}

export interface HealthResponse {
  status: "ok" | "degraded";
  timestamp: string;
  version: string;
  checks: {
    supabase: { ok: boolean; message: string };
    storage: { ok: boolean; message: string };
    dataset: { ok: boolean; message: string; details?: unknown };
    model: { ok: boolean; message: string; details?: unknown };
  };
}

export interface DashboardStats {
  total_scans: number;
  healthy_results: number;
  diseased_results: number;
  low_confidence_results: number;
  scans_last_30_days: number;
  /** `null` when there are no scans - never a fabricated 0%. */
  healthy_percentage: number | null;
  favourite_disease: { class_name: string; count: number } | null;
  recent_scans: Scan[];
  by_class: { class_name: string; count: number }[];
  by_input_type: { input_type: string; count: number }[];
  trend: { date: string; count: number }[];
}

export interface Paginated<T> {
  data: T[];
  pagination: { page: number; page_size: number; total: number; total_pages: number };
}

export interface DatasetStatusResponse {
  configured: boolean;
  status_label: string;
  dataset: DatasetMetadata | null;
  local: {
    raw_dir: string;
    manifest_exists: boolean;
    split_manifest_exists: boolean;
    processed_dir: string;
  };
  message: string;
}

export interface ModelStatusResponse {
  configured: boolean;
  status_label: string;
  model: ModelVersion | null;
  versions: {
    version: string;
    trained_at: string | null;
    status: ModelStatus;
    test_accuracy: number | null;
    validation_accuracy: number | null;
    model_checksum: string | null;
    classes: string[];
    notes: string;
  }[];
  severity_supported: boolean;
  min_confidence: number;
  message: string;
}

export interface SystemStatus {
  supabase: { connected: boolean; message: string };
  storage: { connected: boolean; buckets: Record<string, { accessible: boolean; error?: string }> };
  dataset: { available: boolean; message: string };
  model: { available: boolean; message: string };
  python: { available: boolean; version?: string; message: string };
}
