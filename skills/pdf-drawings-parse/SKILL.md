---
name: pdf-drawings-parse
description: "Inspect vector PDF drawings, extract positioned text and geometry, calibrate scale and prepare DXF references."
---


# PDF drawings

Distinguish vector drawings from raster scans before extraction. A scan needs OCR and carries different accuracy limits; do not claim vector precision for it.

Helpers: `scripts/pdf_survey.py`, `pdf_text.py`, `pdf_calibrate.py`, `pdf_to_dxf.py`. Run each with `--help` before use. Optional dependencies: PyMuPDF, ezdxf and shapely; install into an isolated Python environment, following the project's dependency documentation.

Confirm page units, rotation, crop boxes and source scale. Calibrate with known independent dimensions, compare residuals, and preserve page coordinates plus the transform to model coordinates. Check several points, axes and dimensions after conversion. Do not infer a universal millimeter accuracy from a previous drawing.

Retain source identity and clearly distinguish source vectors, reconstructed lines, OCR text and interpreted model elements. A converted DXF is a reference, not a complete Revit model.
