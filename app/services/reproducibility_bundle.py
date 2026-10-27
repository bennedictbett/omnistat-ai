"""Build an in-memory archive without executing code or retaining uploaded data."""
import base64
import binascii
import hashlib
import io
import json
import zipfile

import pandas as pd
from pydantic import BaseModel, ConfigDict, Field

from app.services.analysis_plan import AnalysisPlan, prepare_analysis_plan
from app.services.r_templates import TEMPLATES, TemplateError, _script_for, prepare_test_data

MAX_BUNDLE_BYTES = 20 * 1024**2


class BundleError(ValueError):
    pass


class BundleResult(BaseModel):
    model_config = ConfigDict(extra="allow", strict=True)

    ok: bool
    test: str
    title: str
    variables: dict[str, str]
    results: dict
    error: str | None
    plots: list[str] = Field(max_length=100)
    timed_out: bool
    duration_s: float
    code: str
    data_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    r_version: str | None
    analysis_plan: AnalysisPlan | None = None


def build_bundle(result: BundleResult, rows: list[dict]) -> bytes:
    if not result.ok or result.error or result.timed_out:
        raise BundleError("Only successful analyses can be exported")
    df = pd.DataFrame(rows)
    csv = prepare_test_data(result.test, result.variables, df)
    digest = hashlib.sha256(csv).hexdigest()
    if digest != result.data_sha256:
        raise BundleError("The selected data no longer matches this result. Run the analysis again before exporting.")
    if not result.r_version:
        raise BundleError("The result has no recorded R version. Run the analysis again before exporting.")
    script = _script_for(TEMPLATES[result.test], result.variables, digest, result.r_version)
    if result.code != script:
        raise BundleError("The R script no longer matches the current template. Run the analysis again before exporting.")
    if result.analysis_plan is not None:
        plan = prepare_analysis_plan(result.test, result.variables, df)
        if result.analysis_plan != plan:
            raise BundleError("The analysis plan does not match the selected data and template. Review and run it again.")
    try:
        result_json = json.dumps(result.model_dump(exclude_none=False), indent=2, allow_nan=False).encode()
    except (ValueError, TypeError) as e:
        raise BundleError("The result contains values that cannot be exported as JSON") from e
    files = {"data.csv": csv, "analysis.R": script.encode(), "results.json": result_json}
    if result.analysis_plan is not None:
        files["analysis-plan.json"] = result.analysis_plan.model_dump_json(indent=2).encode()
    for index, plot in enumerate(result.plots, 1):
        if len(plot) > 8 * 1024**2:
            raise BundleError("A chart is too large to export")
        try:
            png = base64.b64decode(plot, validate=True)
        except (binascii.Error, ValueError) as e:
            raise BundleError("A chart is not valid base64") from e
        if not png.startswith(b"\x89PNG\r\n\x1a\n"):
            raise BundleError("A chart is not a PNG image")
        files[f"plots/plot-{index:02d}.png"] = png
    manifest = {
        "bundle_version": "1.0", "test": result.test, "engine": "r",
        "r_version": result.r_version, "data_sha256": digest,
        "rows_exported": len(df), "columns": list(dict.fromkeys(result.variables.values())),
        "files": {name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
                  for name, content in files.items()},
        "notice": "User-supplied result snapshot, not a signed server attestation. Data includes selected rows before complete-case exclusions.",
    }
    files["manifest.json"] = json.dumps(manifest, indent=2).encode()
    files["README.txt"] = (
        "OmniStat reproducibility bundle\n\n"
        "SENSITIVE DATA: data.csv contains the selected uploaded columns and all rows sent to R,\n"
        "including rows later excluded by the procedure. Charts and outputs may identify people.\n"
        "Store and share only with appropriate authorization.\n\n"
        "Extract the archive into a private folder. Use the R version recorded in manifest.json.\n"
        "Review analysis.R, then run from that folder: Rscript analysis.R\n"
        "The curated analyses use R's standard/recommended packages; no packages are installed by the script.\n"
        "Rscript writes plot output to Rplots.pdf. Results print to the terminal;\n"
        "results.json is the saved original response, not overwritten by rerunning the script.\n"
        "Plots and low-order numeric digits can differ across R/platform versions.\n\n"
        "manifest.json lists SHA-256 fingerprints of data, code, results, plan (if present) and charts.\n"
        "It does not sign or authenticate this snapshot. No analysis is rerun during export.\n"
        "No original workbook, unrelated columns, passwords or API keys are deliberately attached.\n"
    ).encode()
    if sum(map(len, files.values())) > MAX_BUNDLE_BYTES:
        raise BundleError("This bundle exceeds the 20 MB uncompressed export limit")
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for name, content in files.items():
            zipped.writestr(name, content)
    return archive.getvalue()
