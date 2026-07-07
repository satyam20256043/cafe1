@echo off
title Cafe HQ — Data Cleanup
color 0A
echo.
echo  Removing ghost branch folders...
cd /d C:\Users\pc\.claude\sessions\cafe-ai-bot\data
for /d %%f in (coffee_house_jayanagar_*) do (
    echo  Deleting %%f
    rd /s /q "%%f"
)
echo.
echo  Done! Ghost folders removed.
pause
