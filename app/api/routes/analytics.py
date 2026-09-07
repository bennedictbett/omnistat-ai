from fastapi import APIRouter, UploadFile, File
from app.services.analytics_service import AnalyticsService

router = APIRouter()
service = AnalyticsService()

@router.post("/upload")
async def upload_file(file: UploadFile = File(...)):
    """Upload clinical Excel/CSV file for analysis"""
    return await service.parse_file(file)

@router.post("/normality")
async def normality_check(data: dict):
    """
    Run Shapiro-Wilk normality test
    Body: { "values": [1.2, 2.3, 3.1, ...] }
    """
    return service.normality_test(data)

@router.post("/survival")
async def survival_curve(data: dict):
    """
    Generate Kaplan-Meier survival curve
    Body: { "durations": [...], "event_observed": [...], "label": "Group A" }
    """
    return service.kaplan_meier(data)

@router.post("/descriptive")
async def descriptive_stats(data: dict):
    """
    Run descriptive statistics on a list of values
    Body: { "values": [...], "column": "blood_pressure" }
    """
    return service.descriptive_statistics(data)