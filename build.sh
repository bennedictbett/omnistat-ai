#!/bin/bash
pip install --upgrade pip setuptools wheel
pip install --only-binary=:all: numpy==1.26.4
pip install --only-binary=:all: pandas==2.2.2
pip install --only-binary=:all: scipy==1.13.0
pip install fastapi==0.111.0 uvicorn==0.29.0 python-multipart==0.0.9 openpyxl==3.1.2 lifelines==0.27.8 groq==0.8.0 python-dotenv==1.0.1 pydantic==2.7.1