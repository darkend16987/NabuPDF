"""PDF comparison: text word-stream diff and visual drawing diff."""

from .comparator import compare_pdfs, compare_pdfs_steps
from .drawing import annotate_pdf, compare_drawings

__all__ = ["compare_pdfs", "compare_pdfs_steps", "compare_drawings", "annotate_pdf"]
