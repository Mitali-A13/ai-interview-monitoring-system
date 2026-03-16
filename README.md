[![Review Assignment Due Date](https://classroom.github.com/assets/deadline-readme-button-22041afd0340ce965d47ae6ef1cefeee28c7c493a6346c4f15d667ab976d596c.svg)](https://classroom.github.com/a/exDom1tE)
[![Open in Visual Studio Code](https://classroom.github.com/assets/open-in-vscode-2e0aaae1b6195c2367325f4f02e2d04e9abb55f0b24a779b69b11b9e10269abc.svg)](https://classroom.github.com/online_ide?assignment_repo_id=23149553&assignment_repo_type=AssignmentRepo)
# AI-Powered Interview Monitoring System

## Overview

In this assignment you will build an **AI-powered interview monitoring system** that detects suspicious behavior during an online interview.

The goal is to simulate a **technical interview proctoring platform** that prevents cheating during coding interviews.

The system must monitor the candidate using the webcam and browser events and generate violations if suspicious behavior occurs.

This assignment is part of the **Vertex Buddy AI Hiring Platform**.

---

# Problem Statement

Online technical interviews often suffer from cheating or external assistance.

Your task is to build a **browser-based AI monitoring system** that detects potential cheating behaviors.

The system must detect:

• Tab switching
• Copy / paste attempts
• Multiple faces in camera
• Eye movement away from screen
• Lip movement (possible talking to someone)
• Remote access or window switching

The system should maintain a **violation counter** and terminate the interview after exceeding the allowed limit.

---

# Requirements

You must implement the following features.

### 1. Webcam Monitoring

Capture webcam video using browser APIs and display the camera feed on the interview screen.

### 2. Tab Switch Detection

Detect when the user switches browser tabs or minimizes the window.

Hint:
Use the browser `visibilitychange` event.

### 3. Clipboard Blocking

Prevent copy, paste, and cut operations inside the interview page.

### 4. Face Detection

Detect how many faces are present in the camera feed.

Rules:

* Exactly **1 face allowed**
* If **0 or more than 1 face**, generate a violation.

You may use libraries such as TensorFlow.js or MediaPipe.

### 5. Eye Movement Detection

Detect if the candidate repeatedly looks away from the screen.

If the candidate looks away for more than **5 seconds**, trigger a violation.

### 6. Lip Movement Detection

Detect if the candidate is talking continuously during the interview.

Talking for a prolonged period may indicate external help.

### 7. Violation Engine

Create a rule engine that tracks violations.

Example rules:

* Max tab switches: 3
* Max eye movement warnings: 5
* Max face violations: 2

If violations exceed the limit, terminate the interview.

---

# Expected UI

The interview screen should display:

Camera Feed
Violation Counter
Eye Tracking Status
Face Count
Interview Timer

Example layout:

Camera Feed

Violations: 1 / 3
Faces Detected: 1
Eye Direction: Center

---

# Technologies You May Use

React
Browser APIs
TensorFlow.js
MediaPipe

External AI APIs such as Gemini or OpenAI are **not allowed** for detection logic.

---

# Folder Structure

src
ai-engine
faceDetection.js
eyeTracking.js
lipMovement.js
violationEngine.js

monitoring
tabMonitor.js
clipboardBlock.js
windowMonitor.js

components
CameraFeed.jsx
ViolationCounter.jsx
InterviewScreen.jsx

utils
rules.js

---

# Evaluation Criteria

Face Detection – 20 points
Eye Tracking – 20 points
Tab Monitoring – 15 points
Violation Engine – 15 points
UI / UX – 10 points
Code Quality – 10 points
Documentation – 10 points

Total: 100 points

---

# Submission Instructions

1. Implement the required features.
2. Commit your changes to the repository.
3. Push your final solution to GitHub.

---

