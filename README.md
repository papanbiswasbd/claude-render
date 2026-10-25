---
title: Claude Remotion AutoRender
emoji: 🎬
colorFrom: indigo
colorTo: purple
sdk: docker
app_port: 7860
pinned: false
---

# 🎬 Claude Remotion Auto-Renderer Studio

Claude-এর দেওয়া Remotion প্রজেক্ট ZIP ফাইল সরাসরি আপলোড করলেই অটোমেটিক রেন্ডার হয়ে MP4 ভিডিও দেওয়ার ফ্রি SaaS প্ল্যাটফর্ম।

## ✨ মূল সুবিধাসমূহ:
- **ড্র্যাগ & ড্রপ আপলোড:** Claude-এর ZIP ফাইল সরাসরি ব্রাউজারে ড্রপ করুন।
- **জিরো স্টোরেজ (0% Server Storage):** কোনো ফাইল সার্ভারে স্টোর হয় না; ব্রাউজার রিফ্রেশ বা ট্যাব কাটলেই সব পার্জ হয়ে যায়।
- **বিল্ট-ইন অডিও মার্জার:** ভিডিও রেন্ডারের পর যেকোনো ভয়েসওভার অডিও ১ ক্লিকে (০.৫ সেকেন্ডে) মার্জ করা যায়।
- **ডুয়েল ডাউনলোড:** With Audio ও Without Audio উভয় ফরম্যাটেই ডাউনলোড সুবিধা।
- **বাংলা ফন্ট সাপোর্ট:** লিনাক্স ডকারে বাংলা ফন্ট (Noto & Bengali fonts) ইন্টিগ্রেটেড।

## 🚀 Hugging Face Spaces-এ ডিপ্লয় করার নিয়ম:
1. Hugging Face-এ লগইন করে **New Space** তৈরি করুন।
2. Space SDK হিসেবে **Docker** সিলেক্ট করুন (Blank template)।
3. টার্মিনাল থেকে এই ফোল্ডারের ফাইলগুলো আপনার Space রিপোজিটরিতে পুশ করুন:
   ```bash
   git init
   git remote add origin https://huggingface.co/spaces/YOUR_USERNAME/YOUR_SPACE_NAME
   git add .
   git commit -m "Deploy AutoRender Studio"
   git push -u origin main --force
   ```
4. ২-৩ মিনিটে ডকার ইমেজ বিল্ড হয়ে আপনার ফ্রি পাবলিক লাইভ লিঙ্ক রেডি হয়ে যাবে!
