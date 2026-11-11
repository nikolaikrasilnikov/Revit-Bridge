---
name: dwg-plans-parse
description: "Inspect DXF layers, positioned text and geometric segments and prepare drawing references for Revit."
---


# DWG / DXF drawing references

The packaged helpers read DXF, not arbitrary DWG binaries. For DWG, use an independently installed authorized converter and verify its output; no converter binary is bundled.

Use `scripts/dxf_survey.py` for inventory, `scripts/dxf_segments.py` for geometry and `scripts/render_segments.py` for visual inspection. Read their `--help` first. Optional Python dependencies: ezdxf, shapely and matplotlib.

Confirm source version, units, model/paper space, blocks and insertion transforms, layers and external references. Preserve all applicable coordinate transforms and source handles. Text and layer names are clues, not proof of element semantics.

Review representative plans and compare independent dimensions before using extracted data for native modeling. Do not equate every closed contour with a room, or every inner loop with a shaft. Treat unresolved external references and unsupported entities as coverage gaps.
