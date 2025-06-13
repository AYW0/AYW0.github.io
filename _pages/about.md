---
permalink: /
title: "About"
excerpt: "About"
author_profile: true
redirect_from: 
  - /about/
  - /about.html
---

Hi! I’m Alex, an incoming PhD student in the Human-Computer Interaction Institute (HCII) at Carnegie Mellon University. I work with Professors David Lindlbauer ([Augmented Perception Lab](https://augmented-perception.org/)) and Chris Donahue ([Generative Creativity Lab](https://chrisdonahue.com/)). 

My work lies at the intersection of **technical human-computer interaction** and **music computing**, where I aim to revolutionize how we engage with sound and music through adaptive experiences. To achieve this, my current research focuses on two key areas: **(1) developing context-aware systems** that intelligently adapt and generate audio to enhance user experiences, and **(2) creating AI-driven tools** that support content creators in authoring such experiences. My work in adaptive audio has been published in premier **HCI conferences including ACM CHI and UIST**, with a best paper honorable mention award at CHI 2024.


Previously, I worked with Professor Dhruv Jain as a visiting researcher at the [Soundability Lab](https://accessibility.eecs.umich.edu/), University of Michigan. I hold an MS in Music and Technology from Carnegie Mellon University, and a BS in Interactive Media Arts🎨 from NYU Shanghai, where I also minored in Computer Science💻, Game Design🎮, and Music🎼.


<h1>News</h1>
<strong>February 2025</strong> I will join CMU HCII as a PhD student starting Fall 2025!

<strong>June 2024</strong> Excited to join the [Soundability Lab](https://accessibility.eecs.umich.edu/)!

<strong>April 2024</strong> [MARingBA](https://ayw0.github.io/publications/2024-MARingBA/) received a <i class="fas fa-award" style="color: red;"></i> <strong style="color: red;"> Best Paper Honorable Mention (top 5%)</strong> at CHI 2024!

<h1>Selected Publications</h1>

{% assign sorted_publications = site.publications | sort: 'date' | reverse %}


{% for post in sorted_publications %}
  {% include archive-single.html %}
{% endfor %}




