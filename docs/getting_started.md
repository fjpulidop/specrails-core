![Logo](../images/Getting_started.png)

# Getting Started Guide

This document provides a step-by-step guide on how to setup your environment and get started with the DeckDex MTG project.

## Prerequisites

To work with this project, you need to have the following installed:

1. Python 3.6 or higher.
2. pip (Python package manager).

## Environment Setup

### Step 1: Clone the repository

Clone this repository to your local machine using the following command:

```commandline
git clone https://github.com/fjpulidop/deckdex_mtg.git
```

### Step 2: Navigate to the project directory
Change your current directory to the project's directory:
```commandline
cd deckdex_mtg
```

### Step 3: Create a virtual environment
Create a virtual environment for the project. This helps to keep the project and its dependencies isolated from other projects:
```commandline
python3 -m venv venv
```

### Step 4: Activate the virtual environment
Activate the virtual environment:
```commandline
source venv/bin/activate
```

### Step 5: Install the project's dependencies
Install the project's dependencies:
```commandline
pip install -r requirements.txt
```

### Step 6: Set up the necessary environment variables
You need to set up two environment variables:
- GOOGLE_API_CREDENTIALS: This should point to the JSON file containing your Google Sheets API credentials.
- OPENAI_API_KEY: This should be your OpenAI API key.
You can do this by creating a .env file in the project's root directory and adding the following lines:
```commandline
GOOGLE_API_CREDENTIALS=/path/to/credentials.json
OPENAI_API_KEY=your_openai_api_key
```
### Step 7: Set up Google Sheets
You need to have a Google Sheet in your Google account with the following columns in the first row:
```commandline
Name,English name,Type,Description,Keywords,Mana Cost,Cmc,Color,Identity,Colors,Strength,Resistance,Rarity,Price,Release,Date,Set ID,Set Name,Number in Set,Edhrec,Rank,Game Strategy,Tier
```
- The column names are important.

Here you have a Google Sheet template: https://docs.google.com/spreadsheets/d/1cjZloPVUytG-lelTDDgoQeMd1TR-scZwPo-eS7eZazc/edit?usp=sharing

This Google Sheet will be used to store the fetched data. The 'Name' column should contain the names of the Magic: The Gathering cards for which you want to fetch data. The script will populate the other columns for you.
Please remember to share this Google Sheet with the service account email that's specified in your JSON credentials file. This is necessary in order to allow the script to access and modify the Google Sheet.

## Running the Tests
To run the project's tests, you can use the following command:
```commandline
python -m unittest discover -s tests
```

## Running the Project
You can run the project without using the OpenAI API by running the following command:
```commandline
python main.py
```
To run the project with the OpenAI API, use the following command:
```commandline
python main.py --use_openai
```
You're now all set to start working with the DeckDex MTG project!