---
name: jupyter-notebook
description: Design, review, or create Jupyter notebooks for experiments and tutorials from user-provided data and requirements in Chat.
---

# Jupyter notebooks in Chat

Use when the user asks for an `.ipynb` notebook, an experiment outline, a tutorial, or a review of an attached notebook. Ask for the dataset or goal only when it changes the cells you would write. Choose `assets/experiment-template.ipynb` for investigations and `assets/tutorial-template.ipynb` for teaching. Consult `references/notebook-structure.md` and the matching experiment or tutorial reference when useful.

Keep cells runnable in order, with short explanations, explicit imports, a small verification cell, and no hidden local paths or credentials. Do not invent results for cells that were not run. If the Chat environment supports creating files, return an `.ipynb` artifact and inspect its JSON and cell order. Otherwise return clearly separated Markdown and code cells the user can copy into a notebook. Use `references/quality-checklist.md` for a final review.
